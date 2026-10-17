import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_BRANCH_TEMPLATE } from "@shared/branch-template";
import type { Project } from "@shared/projects";
import type { StoredBranchRule } from "@main/db/branch-rules-repo";
import type { GitResult, GitRunner } from "@main/git/run-git";
import { executeStartWork, previewStartWork, type StartWorkDeps } from "@main/git/start-work";

const TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

const project = (overrides: Partial<Project> = {}): Project => ({
  id: 1,
  name: "acme/widgets",
  owner: "acme",
  repo: "widgets",
  localPath: "/Users/me/widgets",
  pathExists: true,
  defaultBranch: "main",
  branchFilter: ["*"],
  pollIntervalSec: 30,
  mode: "poll",
  aiEnabled: false,
  enabled: true,
  createdAt: 0,
  ...overrides
});

const rule = (overrides: Partial<StoredBranchRule> = {}): StoredBranchRule => ({
  template: DEFAULT_BRANCH_TEMPLATE,
  versionSource: "package.json",
  exempt: [],
  scope: "default",
  ...overrides
});

const MUTATING = ["fetch", "checkout", "pull", "push"];

const setup = (handler: (key: string) => Partial<GitResult> | undefined = () => undefined, version: string | null = "0.1.0") => {
  const calls: string[] = [];
  const defaults = (key: string): Partial<GitResult> => {
    if (key === "rev-parse --is-inside-work-tree") return { stdout: "true\n" };
    if (key === "remote get-url origin") return { stdout: "git@github.com:acme/widgets.git\n" };
    if (key === "config user.name") return { stdout: "Alice Chen\n" };
    if (key.startsWith("show-ref")) return { code: 1 };
    if (key.startsWith("ls-remote")) return { code: 2 };
    return {};
  };
  const runGit: GitRunner = async (_cwd, args) => {
    const key = args.join(" ");
    calls.push(key);
    return { code: 0, stdout: "", stderr: "", timedOut: false, ...defaults(key), ...handler(key) };
  };
  const deps: StartWorkDeps = {
    runGit,
    readVersion: async () => version,
    now: () => new Date(2026, 9, 9, 10, 30)
  };
  return { deps, calls, mutated: () => calls.filter((call) => MUTATING.includes(call.split(" ")[0] as string)) };
};

describe("previewStartWork", () => {
  it("builds the house-convention branch name and the exact steps", async () => {
    const t = setup();
    const preview = await previewStartWork(t.deps, project(), rule(), {});

    assert.ok(preview.ok);
    assert.equal(preview.plan.branch, "v010_2026_1009");
    assert.equal(preview.plan.baseBranch, "main");
    assert.deepEqual(preview.plan.steps, [
      "git fetch origin",
      "git checkout main",
      "git pull --ff-only origin main",
      "git checkout -b v010_2026_1009",
      "git push -u origin v010_2026_1009"
    ]);
    assert.deepEqual(t.mutated(), [], "previewing never changes anything");
  });

  it("stops when the project has no local path or the path is not a repo", async () => {
    const t = setup();
    const noPath = await previewStartWork(t.deps, project({ localPath: null }), rule(), {});
    assert.ok(!noPath.ok && noPath.reason === "no-local-path");

    const notRepo = setup((key) => (key === "rev-parse --is-inside-work-tree" ? { code: 128, stdout: "" } : undefined));
    const result = await previewStartWork(notRepo.deps, project(), rule(), {});
    assert.ok(!result.ok && result.reason === "not-a-repo");
  });

  it("reports a missing origin", async () => {
    const t = setup((key) => (key === "remote get-url origin" ? { code: 2 } : undefined));
    const result = await previewStartWork(t.deps, project(), rule(), {});
    assert.ok(!result.ok && result.reason === "no-origin");
  });

  it("refuses to start when the working tree is dirty", async () => {
    const t = setup((key) => (key === "status --porcelain" ? { stdout: " M src/a.ts\n?? new.txt\n" } : undefined));
    const result = await previewStartWork(t.deps, project(), rule(), {});
    assert.ok(!result.ok && result.reason === "dirty");
    assert.deepEqual(t.mutated(), []);
  });

  it("never overwrites: an existing local or remote branch of the same name blocks", async () => {
    const local = setup((key) => (key.startsWith("show-ref") ? { code: 0 } : undefined));
    const localResult = await previewStartWork(local.deps, project(), rule(), {});
    assert.ok(!localResult.ok && localResult.reason === "exists");
    assert.ok(localResult.message.includes("v010_2026_1009"));

    const remote = setup((key) => (key.startsWith("ls-remote") ? { code: 0, stdout: "abc\trefs/heads/v010_2026_1009\n" } : undefined));
    const remoteResult = await previewStartWork(remote.deps, project(), rule(), {});
    assert.ok(!remoteResult.ok && remoteResult.reason === "exists");
  });

  it("does not treat an unreachable origin as 'branch is free'", async () => {
    const t = setup((key) => (key.startsWith("ls-remote") ? { code: 128, stderr: "fatal: could not read from remote" } : undefined));
    const result = await previewStartWork(t.deps, project(), rule(), {});
    assert.ok(!result.ok && result.reason === "remote");
  });

  it("reports an unreadable version", async () => {
    const t = setup(() => undefined, null);
    const result = await previewStartWork(t.deps, project(), rule(), {});
    assert.ok(!result.ok && result.reason === "version");

    const garbage = setup(() => undefined, "latest");
    assert.ok(!(await previewStartWork(garbage.deps, project(), rule(), {})).ok);
  });

  it("falls back to origin/HEAD when the default branch is unknown, else blocks", async () => {
    const withHead = setup((key) => (key.startsWith("symbolic-ref") ? { stdout: "origin/trunk\n" } : undefined));
    const ok = await previewStartWork(withHead.deps, project({ defaultBranch: null }), rule(), {});
    assert.ok(ok.ok);
    assert.equal(ok.plan.baseBranch, "trunk");

    const none = setup((key) => (key.startsWith("symbolic-ref") ? { code: 128 } : undefined));
    const result = await previewStartWork(none.deps, project({ defaultBranch: null }), rule(), {});
    assert.ok(!result.ok && result.reason === "default-branch");
  });

  it("refuses a broken template instead of guessing", async () => {
    const t = setup();
    const result = await previewStartWork(t.deps, project(), rule({ template: "v{versoin}" }), {});
    assert.ok(!result.ok && result.reason === "template");
  });
});

describe("templates that need input", () => {
  const custom = rule({ template: "{user}/{type}/{slug}" });

  it("builds the name from git user.name, type and a sanitised slug", async () => {
    const t = setup();
    const result = await previewStartWork(t.deps, project(), custom, { type: "feat", slug: "Login Page!" });
    assert.ok(result.ok);
    assert.equal(result.plan.branch, "alice-chen/feat/login-page");
  });

  it("asks for what is missing or unusable", async () => {
    const t = setup();
    for (const input of [{}, { type: "feat" }, { slug: "x" }, { type: "Feat!", slug: "x" }, { type: "feat", slug: "!!!" }]) {
      const result = await previewStartWork(t.deps, project(), custom, input);
      assert.ok(!result.ok && result.reason === "input", JSON.stringify(input));
    }
  });

  it("needs a git user.name when the template uses {user}", async () => {
    const t = setup((key) => (key === "config user.name" ? { code: 1, stdout: "" } : undefined));
    const result = await previewStartWork(t.deps, project(), custom, { type: "feat", slug: "x" });
    assert.ok(!result.ok && result.reason === "user");
  });

  it("never lets a hostile slug reach git as an option or traversal", async () => {
    const t = setup();
    const result = await previewStartWork(t.deps, project(), rule({ template: "{slug}-{mmdd}" }), { slug: "--upload-pack=evil ../.." });
    assert.ok(result.ok);
    assert.equal(result.plan.branch, "upload-pack-evil-1009");
    assert.ok(!result.plan.branch.startsWith("-"));
  });
});

describe("sequence numbers", () => {
  const seqRule = rule({ template: "feature/{mmdd}-{seq}" });

  it("picks the first unused number", async () => {
    const used = new Set(["feature/1009-1", "feature/1009-2"]);
    const t = setup((key) => {
      const match = /^show-ref --verify --quiet refs\/heads\/(.+)$/.exec(key);
      return match && used.has(match[1] as string) ? { code: 0 } : undefined;
    });
    const result = await previewStartWork(t.deps, project(), seqRule, {});
    assert.ok(result.ok);
    assert.equal(result.plan.branch, "feature/1009-3");
  });
});

describe("executeStartWork", () => {
  it("runs the five steps in order and reports success", async () => {
    const t = setup();
    const preview = await previewStartWork(t.deps, project(), rule(), {});
    assert.ok(preview.ok);

    const result = await executeStartWork(t.deps, project(), rule(), {}, preview.plan.branch);

    assert.ok(result.ok);
    assert.equal(result.branch, "v010_2026_1009");
    assert.deepEqual(t.mutated(), [
      "fetch origin",
      "checkout main",
      "pull --ff-only origin main",
      "checkout -b v010_2026_1009",
      "push -u origin v010_2026_1009"
    ]);
    assert.equal(result.steps.length, 5);
  });

  it("refuses to run a different name than the one the user confirmed", async () => {
    const t = setup();
    const result = await executeStartWork(t.deps, project(), rule(), {}, "v010_2026_0101");
    assert.ok(!result.ok && result.reason === "changed");
    assert.deepEqual(t.mutated(), []);
  });

  it("does not change anything when a precondition fails", async () => {
    const t = setup((key) => (key === "status --porcelain" ? { stdout: " M a\n" } : undefined));
    const result = await executeStartWork(t.deps, project(), rule(), {}, "v010_2026_1009");
    assert.ok(!result.ok && result.reason === "dirty");
    assert.deepEqual(t.mutated(), []);
  });

  it("stops at the first failing step and never goes on to create the branch", async () => {
    const t = setup((key) =>
      key.startsWith("pull") ? { code: 128, stderr: "fatal: Not possible to fast-forward, aborting." } : undefined
    );
    const result = await executeStartWork(t.deps, project(), rule(), {}, "v010_2026_1009");

    assert.ok(!result.ok && result.reason === "step-failed");
    assert.equal(result.steps.length, 3);
    assert.ok(result.steps[2]?.output.includes("fast-forward"));
    assert.ok(!t.calls.some((call) => call.startsWith("checkout -b")));
    assert.ok(!t.calls.some((call) => call.startsWith("push")));
  });

  it("says so when only the push failed", async () => {
    const t = setup((key) => (key.startsWith("push") ? { code: 1, stderr: "rejected" } : undefined));
    const result = await executeStartWork(t.deps, project(), rule(), {}, "v010_2026_1009");

    assert.ok(!result.ok && result.reason === "step-failed");
    assert.ok(result.message.includes("本機分支已建立"));
    assert.equal(result.steps.length, 5);
  });

  it("marks timeouts and keeps secrets out of the recorded output", async () => {
    const t = setup((key) =>
      key.startsWith("fetch")
        ? { code: -1, timedOut: true, stderr: `fatal: unable to access 'https://x-access-token:${TOKEN}@github.com/acme/widgets.git/'` }
        : undefined
    );
    const result = await executeStartWork(t.deps, project(), rule(), {}, "v010_2026_1009");

    assert.ok(!result.ok);
    assert.ok(result.message.includes("逾時"));
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  });
});
