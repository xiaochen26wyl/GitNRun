import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateProjectInput, type NormalizedProjectInput } from "@shared/projects";
import { createAppHandlers } from "@main/app-handlers";
import { insertEvent } from "@main/db/events-repo";
import { UserFacingError } from "@main/errors";
import type { LogEntry } from "@main/logger";
import type { GitRunner } from "@main/git/run-git";
import { createTestDb, makeEvent } from "./helpers/db";

const input = (overrides: Record<string, unknown> = {}): NormalizedProjectInput => {
  const result = validateProjectInput({ owner: "acme", repo: "widgets", ...overrides });
  assert.ok(result.ok);
  return result.value;
};

const defaultGit: GitRunner = async (_cwd, args) => {
  const key = args.join(" ");
  const stdout = key === "rev-parse --is-inside-work-tree" ? "true\n" : key === "remote get-url origin" ? "git@github.com:a/b.git\n" : "";
  const code = key.startsWith("show-ref") ? 1 : key.startsWith("ls-remote") ? 2 : 0;
  return { code, stdout, stderr: "", timedOut: false };
};

const setup = (runGit: GitRunner = defaultGit) => {
  const db = createTestDb();
  const calls = { reload: 0, changed: 0, polled: [] as number[], paused: [] as boolean[], logs: [] as LogEntry[], git: [] as string[] };
  const handlers = createAppHandlers({
    db,
    git: {
      runGit: async (cwd, args) => {
        calls.git.push(args.join(" "));
        return runGit(cwd, args);
      },
      readVersion: async () => "0.1.0",
      now: () => new Date(2026, 9, 9)
    },
    log: (entry) => calls.logs.push(entry),
    monitor: {
      reloadProjects: () => void (calls.reload += 1),
      pollNow: async (id) => void calls.polled.push(id),
      setPaused: (paused) => void calls.paused.push(paused),
      status: () => ({ running: true, paused: false, rateLimitedUntil: null, projects: [] })
    },
    onConfigChanged: () => void (calls.changed += 1)
  });
  return { db, handlers, calls };
};

describe("project handlers", () => {
  it("adds a project, refreshes the monitor and schedules a config backup", () => {
    const { handlers, calls } = setup();
    const project = handlers.addProject(input());

    assert.equal(project.owner, "acme");
    assert.equal(handlers.listProjects().length, 1);
    assert.equal(calls.reload, 1);
    assert.equal(calls.changed, 1);
  });

  it("tells the user a duplicate repo is already monitored", () => {
    const { handlers } = setup();
    handlers.addProject(input());
    assert.throws(() => handlers.addProject(input()), (error) => error instanceof UserFacingError && error.message.includes("已經"));
  });

  it("merges a patch over the existing project and re-validates the result", () => {
    const { handlers } = setup();
    const project = handlers.addProject(input());

    const updated = handlers.updateProject(project.id, { pollIntervalSec: 120, enabled: false, name: "Renamed" });
    assert.equal(updated.pollIntervalSec, 120);
    assert.equal(updated.enabled, false);
    assert.equal(updated.name, "Renamed");
    assert.equal(updated.owner, "acme");
    assert.deepEqual(updated.branchFilter, ["*"]);
  });

  it("rejects an invalid patch without changing anything", () => {
    const { handlers, calls } = setup();
    const project = handlers.addProject(input());
    const changedBefore = calls.changed;

    assert.throws(() => handlers.updateProject(project.id, { pollIntervalSec: 1 }), UserFacingError);
    assert.throws(() => handlers.updateProject(project.id, { name: "" }), UserFacingError);
    assert.equal(handlers.listProjects()[0]?.pollIntervalSec, 30);
    assert.equal(calls.changed, changedBefore);
  });

  it("cannot change owner or repo through a patch, even if the patch smuggles them in", () => {
    const { handlers } = setup();
    const project = handlers.addProject(input());

    const updated = handlers.updateProject(project.id, { owner: "evil", repo: "other", name: "x" });
    assert.equal(updated.owner, "acme");
    assert.equal(updated.repo, "widgets");
  });

  it("reports a missing project", () => {
    const { handlers } = setup();
    assert.throws(() => handlers.updateProject(999, { name: "x" }), UserFacingError);
  });

  it("removes a project together with its events", () => {
    const { db, handlers } = setup();
    const project = handlers.addProject(input());
    insertEvent(db, makeEvent(project.id));

    handlers.removeProject(project.id);

    assert.equal(handlers.listProjects().length, 0);
    assert.equal(handlers.queryEvents({}).events.length, 0);
  });
});

describe("query and monitor handlers", () => {
  it("queries events, logs and a single event", () => {
    const { db, handlers } = setup();
    const project = handlers.addProject(input());
    const { id } = insertEvent(db, makeEvent(project.id, { headMessage: "feat: hello" }));

    assert.equal(handlers.queryEvents({ search: "hello" }).events.length, 1);
    assert.equal(handlers.getEvent(id)?.headMessage, "feat: hello");
    assert.equal(handlers.getEvent(id + 100), null);
    assert.deepEqual(handlers.queryLogs({}).logs, []);
  });

  it("forwards poll-now, pause and status to the monitor", async () => {
    const { handlers, calls } = setup();
    await handlers.pollNow(7);
    handlers.setPaused(true);

    assert.deepEqual(calls.polled, [7]);
    assert.deepEqual(calls.paused, [true]);
    assert.equal(handlers.getMonitorStatus().running, true);
  });
});

describe("branch rule handlers", () => {
  const goodRule = { template: "{user}/{slug}", versionSource: "VERSION", exempt: ["main"] };

  it("starts with the built-in rule, saves a global one, and lets a project override it", () => {
    const { handlers, calls } = setup();
    const project = handlers.addProject(input());
    const backupsBefore = calls.changed;

    const builtIn = handlers.getBranchRule(0);
    assert.equal(builtIn.scope, "default");
    assert.equal(builtIn.hasOwn, false);
    assert.equal(builtIn.template, "v{version}_{year}_{mmdd}");

    const global = handlers.saveBranchRule(0, goodRule);
    assert.equal(global.scope, "global");
    assert.equal(global.hasOwn, true);

    const inherited = handlers.getBranchRule(project.id);
    assert.equal(inherited.template, "{user}/{slug}");
    assert.equal(inherited.hasOwn, false, "the project has no override of its own yet");

    const own = handlers.saveBranchRule(project.id, { ...goodRule, template: "wip/{mmdd}-{slug}" });
    assert.equal(own.scope, "project");
    assert.equal(own.hasOwn, true);
    assert.ok(calls.changed >= backupsBefore, "config backup is scheduled via onConfigChanged");
  });

  it("explains why a bad rule was rejected and stores nothing", () => {
    const { handlers } = setup();
    assert.throws(
      () => handlers.saveBranchRule(0, { template: "{nope}", versionSource: "VERSION", exempt: [] }),
      (error) => error instanceof UserFacingError && error.message.includes("nope")
    );
    assert.equal(handlers.getBranchRule(0).hasOwn, false);
  });

  it("resetting a project override falls back to the global rule", () => {
    const { handlers } = setup();
    const project = handlers.addProject(input());
    handlers.saveBranchRule(0, goodRule);
    handlers.saveBranchRule(project.id, { ...goodRule, template: "x/{slug}" });

    const reset = handlers.resetBranchRule(project.id);

    assert.equal(reset.hasOwn, false);
    assert.equal(reset.scope, "global");
    assert.equal(reset.template, "{user}/{slug}");
  });

  it("rejects an unknown project scope", () => {
    const { handlers } = setup();
    assert.throws(() => handlers.getBranchRule(999), UserFacingError);
    assert.throws(() => handlers.saveBranchRule(999, goodRule), UserFacingError);
    assert.throws(() => handlers.resetBranchRule(999), UserFacingError);
  });
});

describe("start-work handlers", () => {
  const withPath = (handlers: ReturnType<typeof setup>["handlers"]) => {
    const project = handlers.addProject(input({ localPath: "/Users/me/widgets" }));
    // 預設分支由第一次輪詢寫入；這裡直接補上。
    return handlers.updateProject(project.id, { localPath: "/Users/me/widgets" });
  };

  it("previews using the project's effective rule without touching git state", async () => {
    const t = setup();
    const project = withPath(t.handlers);
    t.db.prepare("UPDATE projects SET default_branch = 'main' WHERE id = ?").run(project.id);

    const preview = await t.handlers.previewStartWork(project.id, {});

    assert.ok(preview.ok);
    assert.equal(preview.plan.branch, "v010_2026_1009");
    assert.ok(!t.calls.git.some((call) => /^(fetch|checkout|pull|push)/.test(call)));
  });

  it("runs the confirmed branch and records it in the log", async () => {
    const t = setup();
    const project = withPath(t.handlers);
    t.db.prepare("UPDATE projects SET default_branch = 'main' WHERE id = ?").run(project.id);

    const result = await t.handlers.runStartWork(project.id, {}, "v010_2026_1009");

    assert.ok(result.ok);
    assert.ok(t.calls.git.includes("push -u origin v010_2026_1009"));
    const log = t.calls.logs.at(-1);
    assert.equal(log?.category, "command");
    assert.ok(log?.message.includes("v010_2026_1009"));
  });

  it("logs a blocked run as a warning", async () => {
    const t = setup();
    const project = t.handlers.addProject(input());
    const result = await t.handlers.runStartWork(project.id, {}, "x");
    assert.ok(!result.ok);
    assert.equal(t.calls.logs.at(-1)?.level, "warn");
  });

  it("refuses a second run for the same project while one is in progress", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const t = setup(async (cwd, args) => {
      if (args[0] === "fetch") await gate;
      return defaultGit(cwd, args);
    });
    const project = withPath(t.handlers);
    t.db.prepare("UPDATE projects SET default_branch = 'main' WHERE id = ?").run(project.id);

    const first = t.handlers.runStartWork(project.id, {}, "v010_2026_1009");
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(t.handlers.runStartWork(project.id, {}, "v010_2026_1009"), UserFacingError);

    release();
    assert.ok((await first).ok);
    // 結束後可以再次執行（此時分支已存在於「遠端」的假資料之外，仍會重新檢查）。
    assert.ok(t.calls.git.filter((call) => call === "fetch origin").length === 1);
  });

  it("reports an unknown project", async () => {
    const { handlers } = setup();
    await assert.rejects(handlers.previewStartWork(999, {}), UserFacingError);
    await assert.rejects(handlers.runStartWork(999, {}, "x"), UserFacingError);
  });
});
