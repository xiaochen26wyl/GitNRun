import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MonitorChange } from "@shared/monitor";
import type { LogEntry } from "@main/logger";
import { addProject, updateProject } from "@main/db/projects-repo";
import { getPollMeta } from "@main/db/poll-state-repo";
import { queryEvents } from "@main/db/events-repo";
import { GithubApiError } from "@main/github/client";
import { createIngest } from "@main/monitor/ingest";
import { PollScheduler } from "@main/monitor/scheduler";
import { classifyPollError, createMonitorService } from "@main/monitor/service";
import { SecretMissingError, SecretUnreadableError } from "@main/vault/vault";
import { createTestDb } from "./helpers/db";
import { commit, createFakeClient, createFakeRepo, sha } from "./helpers/fake-github";

const setup = (projectOverrides: Partial<Parameters<typeof addProject>[1]> = {}) => {
  const db = createTestDb();
  const project = addProject(db, {
    owner: "acme",
    repo: "widgets",
    name: "acme/widgets",
    localPath: null,
    branchFilter: ["*"],
    pollIntervalSec: 30,
    mode: "poll",
    enabled: true,
    aiEnabled: false,
    ...projectOverrides
  });
  const repo = createFakeRepo({ branches: [{ name: "main", sha: sha(1) }] });
  const fake = createFakeClient(repo);
  const logs: LogEntry[] = [];
  const changes: MonitorChange[] = [];
  let clock = 1_000_000;
  const scheduler = new PollScheduler({ random: () => 0 });
  const service = createMonitorService({
    db,
    client: fake.client,
    scheduler,
    ingest: createIngest({ db }),
    now: () => clock,
    log: (entry) => logs.push(entry),
    emit: (change) => changes.push(change)
  });
  return {
    db,
    project,
    repo,
    fake,
    logs,
    changes,
    scheduler,
    service,
    advance: (ms: number) => (clock += ms)
  };
};

describe("polling loop", () => {
  it("polls due projects, records a baseline, then reports pushes", async () => {
    const t = setup();
    t.service.reloadProjects();

    await t.service.tick();
    assert.equal(queryEvents(t.db).events.length, 0);
    assert.ok(t.logs.some((entry) => entry.message.includes("基準")));

    t.advance(60_000);
    t.repo.branches = [{ name: "main", sha: sha(10) }];
    t.repo.etag = 'W/"etag-2"';
    t.repo.compares.set(`${sha(1)}...${sha(10)}`, { commits: [commit(10, "feat: x")], files: [], totalCommits: 1 });
    await t.service.tick();

    assert.equal(queryEvents(t.db).events.length, 1);
    assert.ok(t.changes.some((change) => change.events));
  });

  it("does not poll before the interval has elapsed", async () => {
    const t = setup();
    t.service.reloadProjects();
    await t.service.tick();
    t.fake.calls.length = 0;

    t.advance(5_000);
    await t.service.tick();

    assert.deepEqual(t.fake.calls, []);
  });

  it("does not poll projects that are disabled or webhook-only", async () => {
    const t = setup({ mode: "webhook" });
    t.service.reloadProjects();
    await t.service.tick();
    assert.deepEqual(t.fake.calls, []);

    updateProject(t.db, t.project.id, {
      owner: "acme", repo: "widgets", name: "acme/widgets", localPath: null,
      branchFilter: ["*"], pollIntervalSec: 30, mode: "poll", enabled: false, aiEnabled: false
    });
    t.service.reloadProjects();
    await t.service.tick();
    assert.deepEqual(t.fake.calls, []);
  });

  it("picks up newly enabled projects and drops removed ones on reload", async () => {
    const t = setup();
    t.service.reloadProjects();
    assert.equal(t.scheduler.snapshot().length, 1);

    t.db.prepare("DELETE FROM projects").run();
    t.service.reloadProjects();
    assert.equal(t.scheduler.snapshot().length, 0);
  });
});

describe("pausing", () => {
  it("does nothing while the user has paused monitoring", async () => {
    const t = setup();
    t.service.reloadProjects();
    t.service.setPaused(true);
    await t.service.tick();

    assert.deepEqual(t.fake.calls, []);
    assert.equal(t.service.status().paused, true);

    t.service.setPaused(false);
    await t.service.tick();
    assert.ok(t.fake.calls.length > 0);
  });

  it("pollNow checks immediately even while paused", async () => {
    const t = setup();
    t.service.reloadProjects();
    t.service.setPaused(true);

    await t.service.pollNow(t.project.id);

    assert.ok(t.fake.calls.includes("list"));
    assert.equal(getPollMeta(t.db, t.project.id).baselineDone, true);
  });

  it("slows down and pauses via GitHub's rate limit headers", async () => {
    const t = setup();
    t.service.reloadProjects();
    t.service.onRateLimit({ remaining: 2, resetAt: 1_000_000 + 300_000 });

    await t.service.tick();

    assert.deepEqual(t.fake.calls, [], "paused until the quota resets");
    assert.equal(t.service.status().rateLimitedUntil, 1_300_000);
  });
});

describe("failures", () => {
  it("records the error, backs off, and logs a repeated problem only once", async () => {
    const t = setup();
    t.repo.failures.list = new GithubApiError("network");
    t.service.reloadProjects();

    await t.service.tick();
    t.advance(120_000);
    await t.service.tick();
    t.advance(300_000);
    await t.service.tick();

    assert.equal(getPollMeta(t.db, t.project.id).lastError, "無法連線到 GitHub");
    assert.equal(t.logs.filter((entry) => entry.level === "warn").length, 1);
    assert.equal(t.service.status().projects[0]?.lastError, "無法連線到 GitHub");

    // 恢復後清掉錯誤，之後再出問題會重新記一筆。
    t.repo.failures = {};
    t.advance(600_000);
    await t.service.tick();
    assert.equal(getPollMeta(t.db, t.project.id).lastError, null);
    t.repo.failures.list = new GithubApiError("network");
    t.repo.etag = 'W/"etag-9"';
    t.advance(600_000);
    await t.service.tick();
    assert.equal(t.logs.filter((entry) => entry.level === "warn").length, 2);
  });

  it("pauses everything when GitHub says we are rate limited", async () => {
    const t = setup();
    t.repo.failures.list = new GithubApiError("rate-limited", 403, 90_000);
    t.service.reloadProjects();

    await t.service.tick();

    assert.equal(t.scheduler.isPaused(1_000_001), true);
    assert.equal(t.service.status().rateLimitedUntil, 1_090_000);
  });

  it("never lets one project's failure stop the others", async () => {
    const t = setup();
    addProject(t.db, {
      owner: "acme", repo: "second", name: "acme/second", localPath: null,
      branchFilter: ["*"], pollIntervalSec: 30, mode: "poll", enabled: true, aiEnabled: false
    });
    let calls = 0;
    const original = t.fake.client.listBranches;
    t.fake.client.listBranches = async (owner, repoName, etag) => {
      calls += 1;
      if (repoName === "widgets") {
        throw new GithubApiError("server", 500);
      }
      return original(owner, repoName, etag);
    };
    t.service.reloadProjects();

    await t.service.tick();

    assert.equal(calls, 2);
    const second = t.db.prepare("SELECT id FROM projects WHERE repo = 'second'").get();
    assert.equal(getPollMeta(t.db, Number(second?.id)).baselineDone, true);
  });
});

describe("classifyPollError", () => {
  it("gives fixed, request-free messages", () => {
    assert.equal(classifyPollError(new SecretMissingError("github.pat")).kind, "no-token");
    assert.equal(classifyPollError(new SecretUnreadableError("github.pat")).kind, "no-token");
    assert.equal(classifyPollError(new GithubApiError("auth", 401)).kind, "auth");
    assert.equal(classifyPollError(new GithubApiError("not-found", 404)).kind, "not-found");
    assert.equal(classifyPollError(new GithubApiError("forbidden", 403)).kind, "forbidden");
    assert.equal(classifyPollError(new GithubApiError("server", 503)).kind, "server");
    assert.equal(classifyPollError(new GithubApiError("network")).kind, "network");
    assert.equal(classifyPollError(new Error("ghp_" + "x".repeat(36))).message, "輪詢失敗");
  });
});
