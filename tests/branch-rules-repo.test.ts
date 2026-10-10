import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_BRANCH_TEMPLATE, validateBranchRuleInput } from "@shared/branch-template";
import { createBranchChecker } from "@main/branch-checker";
import {
  BUILT_IN_BRANCH_RULE,
  GLOBAL_SCOPE,
  deleteBranchRule,
  getEffectiveBranchRule,
  getOwnBranchRule,
  saveBranchRule
} from "@main/db/branch-rules-repo";
import { addProject } from "@main/db/projects-repo";
import { readProjectVersion } from "@main/git/version-source";
import { createTestDb } from "./helpers/db";

const makeProject = (db: ReturnType<typeof createTestDb>, repo = "widgets") =>
  addProject(db, {
    owner: "acme", repo, name: `acme/${repo}`, localPath: null,
    branchFilter: ["*"], pollIntervalSec: 30, mode: "poll", enabled: true, aiEnabled: false
  });

describe("effective branch rule", () => {
  it("falls back project → global → built-in", () => {
    const db = createTestDb();
    const project = makeProject(db);

    assert.deepEqual(getEffectiveBranchRule(db, project.id), BUILT_IN_BRANCH_RULE);
    assert.equal(BUILT_IN_BRANCH_RULE.template, DEFAULT_BRANCH_TEMPLATE);

    saveBranchRule(db, GLOBAL_SCOPE, { template: "{user}/{slug}", versionSource: "VERSION", exempt: ["main"] });
    const global = getEffectiveBranchRule(db, project.id);
    assert.equal(global.template, "{user}/{slug}");
    assert.equal(global.scope, "global");
    assert.equal(global.versionSource, "VERSION");

    saveBranchRule(db, project.id, { template: "wip/{mmdd}-{slug}", versionSource: "git-tag", exempt: [] });
    const own = getEffectiveBranchRule(db, project.id);
    assert.equal(own.template, "wip/{mmdd}-{slug}");
    assert.equal(own.scope, "project");
    assert.deepEqual(own.exempt, []);
  });

  it("one project's override does not affect another", () => {
    const db = createTestDb();
    const a = makeProject(db, "a");
    const b = makeProject(db, "b");
    saveBranchRule(db, a.id, { template: "x/{slug}", versionSource: "package.json", exempt: [] });

    assert.equal(getEffectiveBranchRule(db, a.id).template, "x/{slug}");
    assert.equal(getEffectiveBranchRule(db, b.id).template, DEFAULT_BRANCH_TEMPLATE);
  });

  it("updates in place and can drop an override", () => {
    const db = createTestDb();
    const project = makeProject(db);
    saveBranchRule(db, project.id, { template: "a/{slug}", versionSource: "package.json", exempt: [] });
    saveBranchRule(db, project.id, { template: "b/{slug}", versionSource: "package.json", exempt: [] });
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM branch_rules").get()?.n), 1);
    assert.equal(getOwnBranchRule(db, project.id)?.template, "b/{slug}");

    deleteBranchRule(db, project.id);
    assert.equal(getOwnBranchRule(db, project.id), null);
    assert.equal(getEffectiveBranchRule(db, project.id).scope, "default");
  });

  it("deleting a project removes its override (trigger)", () => {
    const db = createTestDb();
    const project = makeProject(db);
    saveBranchRule(db, project.id, { template: "a/{slug}", versionSource: "package.json", exempt: [] });
    db.prepare("DELETE FROM projects WHERE id = ?").run(project.id);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM branch_rules").get()?.n), 0);
  });

  it("tolerates a corrupt stored row instead of crashing the pipeline", () => {
    const db = createTestDb();
    const project = makeProject(db);
    db.prepare(
      "INSERT INTO branch_rules (project_id, template, version_source, exempt_json, created_at, updated_at) VALUES (?, 't/{slug}', 'bogus', 'not json', 0, 0)"
    ).run(project.id);
    const rule = getEffectiveBranchRule(db, project.id);
    assert.equal(rule.versionSource, "package.json");
    assert.deepEqual(rule.exempt, []);
  });
});

describe("validateBranchRuleInput", () => {
  const ok = { template: "v{version}_{year}_{mmdd}", versionSource: "package.json", exempt: ["main", " release/* "] };

  it("normalises a good input", () => {
    const result = validateBranchRuleInput(ok);
    assert.ok(result.ok);
    assert.deepEqual(result.value.exempt, ["main", "release/*"]);
  });

  it("collects every problem", () => {
    const result = validateBranchRuleInput({ template: "{nope}", versionSource: "svn", exempt: "main" });
    assert.ok(!result.ok);
    assert.ok(result.errors.length >= 3);
  });

  it("rejects bad shapes and entries", () => {
    for (const bad of [null, "x", [], { ...ok, exempt: [""] }, { ...ok, exempt: [5] }, { ...ok, exempt: Array(51).fill("a") }, { ...ok, template: 5 }]) {
      assert.equal(validateBranchRuleInput(bad).ok, false, JSON.stringify(bad));
    }
  });

  it("allows an empty exemption list", () => {
    assert.equal(validateBranchRuleInput({ ...ok, exempt: [] }).ok, true);
  });
});

describe("createBranchChecker", () => {
  it("applies the rule that is effective for each project", () => {
    const db = createTestDb();
    const strict = makeProject(db, "strict");
    const loose = makeProject(db, "loose");
    saveBranchRule(db, loose.id, { template: "{slug}", versionSource: "package.json", exempt: [] });
    const isViolation = createBranchChecker(db);

    assert.equal(isViolation(strict, "feature/login"), true);
    assert.equal(isViolation(strict, "v010_2026_1009"), false);
    assert.equal(isViolation(strict, "main"), false, "default branches are exempt");
    assert.equal(isViolation(loose, "feature-login"), false);
  });
});

describe("readProjectVersion", () => {
  const files = (map: Record<string, string>) => async (path: string): Promise<string> => {
    const text = map[path];
    if (text === undefined) throw new Error("ENOENT");
    return text;
  };
  const noGit = async () => ({ code: 1, stdout: "", stderr: "", timedOut: false });

  it("reads package.json, VERSION and git tags", async () => {
    assert.equal(
      await readProjectVersion({ localPath: "/p", source: "package.json", runGit: noGit, readTextFile: files({ "/p/package.json": '{"version":"1.2.3"}' }) }),
      "1.2.3"
    );
    assert.equal(
      await readProjectVersion({ localPath: "/p", source: "VERSION", runGit: noGit, readTextFile: files({ "/p/VERSION": "0.4.0\nignored\n" }) }),
      "0.4.0"
    );
    assert.equal(
      await readProjectVersion({
        localPath: "/p", source: "git-tag", readTextFile: files({}),
        runGit: async (_cwd, args) => ({ code: 0, stdout: args.join(" ") === "describe --tags --abbrev=0" ? "v2.0.1\n" : "", stderr: "", timedOut: false })
      }),
      "v2.0.1"
    );
  });

  it("returns null for missing files, bad JSON, empty values and failed git", async () => {
    const read = files({ "/p/package.json": "{ not json", "/p/VERSION": "\n" });
    assert.equal(await readProjectVersion({ localPath: "/p", source: "package.json", runGit: noGit, readTextFile: read }), null);
    assert.equal(await readProjectVersion({ localPath: "/p", source: "VERSION", runGit: noGit, readTextFile: read }), null);
    assert.equal(await readProjectVersion({ localPath: "/q", source: "VERSION", runGit: noGit, readTextFile: read }), null);
    assert.equal(await readProjectVersion({ localPath: "/p", source: "git-tag", runGit: noGit, readTextFile: read }), null);
    assert.equal(
      await readProjectVersion({ localPath: "/p", source: "package.json", runGit: noGit, readTextFile: files({ "/p/package.json": '{"version":5}' }) }),
      null
    );
  });
});
