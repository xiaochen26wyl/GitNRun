import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PushEvent } from "@shared/events";
import type { Project } from "@shared/projects";
import { addProject, getProject } from "@main/db/projects-repo";
import { getHeads, getPollMeta } from "@main/db/poll-state-repo";
import { queryEvents } from "@main/db/events-repo";
import { GithubApiError } from "@main/github/client";
import { createIngest } from "@main/monitor/ingest";
import { MAX_CHANGES_PER_POLL, pollProject } from "@main/monitor/poller";
import { createTestDb } from "./helpers/db";
import { commit, createFakeClient, createFakeRepo, sha } from "./helpers/fake-github";

const setup = (branchFilter: string[] = ["*"]) => {
  const db = createTestDb();
  const project = addProject(db, {
    owner: "acme",
    repo: "widgets",
    name: "acme/widgets",
    localPath: null,
    branchFilter,
    pollIntervalSec: 30,
    mode: "poll",
    enabled: true,
    aiEnabled: false
  });
  const repo = createFakeRepo({ branches: [{ name: "main", sha: sha(1) }, { name: "dev", sha: sha(2) }] });
  const fake = createFakeClient(repo);
  const newEvents: PushEvent[] = [];
  const ingest = createIngest({ db, onNewEvent: [(event) => void newEvents.push(event)] });
  let clock = 10_000;
  const poll = async () => {
    // 每次輪詢都重讀專案，因為基準輪詢會寫入 default_branch。
    const current = getProject(db, project.id) as Project;
    return pollProject({ db, client: fake.client, ingest, now: () => (clock += 1000) }, current);
  };
  return { db, project, repo, fake, newEvents, poll };
};

const withCompare = (repo: ReturnType<typeof createFakeRepo>, base: number, head: number, commits = [commit(head, `feat: ${head}`, "alice")]) =>
  repo.compares.set(`${sha(base)}...${sha(head)}`, {
    commits,
    files: [{ path: `f${head}.ts`, status: "modified" }],
    totalCommits: commits.length
  });

describe("first poll", () => {
  it("records a baseline without producing any events", async () => {
    const t = setup();
    const outcome = await t.poll();

    assert.equal(outcome.baselined, true);
    assert.equal(outcome.eventsInserted, 0);
    assert.deepEqual([...getHeads(t.db, t.project.id)].sort(), [["dev", sha(2)], ["main", sha(1)]]);
    assert.equal(queryEvents(t.db).events.length, 0);
    const meta = getPollMeta(t.db, t.project.id);
    assert.equal(meta.baselineDone, true);
    assert.equal(meta.etag, t.repo.etag);
    assert.equal(meta.lastError, null);
    assert.equal(t.db.prepare("SELECT default_branch FROM projects").get()?.default_branch, "main");
  });
});

describe("steady state", () => {
  it("does nothing, cheaply, when the ETag still matches", async () => {
    const t = setup();
    await t.poll();
    t.fake.calls.length = 0;

    const outcome = await t.poll();

    assert.equal(outcome.notModified, true);
    assert.deepEqual(t.fake.calls, ["list(etag)"], "no compare or commit lookups on a 304");
  });

  it("turns a moved branch into one push event and advances its head", async () => {
    const t = setup();
    await t.poll();
    t.repo.branches = [{ name: "main", sha: sha(10) }, { name: "dev", sha: sha(2) }];
    t.repo.etag = 'W/"etag-2"';
    withCompare(t.repo, 1, 10);

    const outcome = await t.poll();

    assert.equal(outcome.eventsInserted, 1);
    const [event] = queryEvents(t.db).events;
    assert.equal(event?.eventType, "push");
    assert.equal(event?.branch, "main");
    assert.equal(event?.beforeSha, sha(1));
    assert.equal(event?.afterSha, sha(10));
    assert.equal(event?.pusher, "alice");
    assert.equal(event?.pusherInferred, true);
    assert.equal(event?.headMessage, "feat: 10");
    assert.deepEqual(event?.files, [{ path: "f10.ts", status: "modified" }]);
    assert.equal(getHeads(t.db, t.project.id).get("main"), sha(10));
    assert.equal(getPollMeta(t.db, t.project.id).etag, 'W/"etag-2"');
    assert.equal(t.newEvents.length, 1);
  });

  it("does not report the same push twice", async () => {
    const t = setup();
    await t.poll();
    t.repo.branches = [{ name: "main", sha: sha(10) }, { name: "dev", sha: sha(2) }];
    t.repo.etag = 'W/"etag-2"';
    withCompare(t.repo, 1, 10);
    await t.poll();
    const second = await t.poll();

    assert.equal(second.notModified, true);
    assert.equal(queryEvents(t.db).events.length, 1);
  });

  it("reports a new branch as 'create', comparing against the default branch head", async () => {
    const t = setup();
    await t.poll();
    t.repo.branches.push({ name: "feature/x", sha: sha(20) });
    t.repo.etag = 'W/"etag-2"';
    withCompare(t.repo, 1, 20);

    await t.poll();

    const [event] = queryEvents(t.db).events;
    assert.equal(event?.eventType, "create");
    assert.equal(event?.branch, "feature/x");
    assert.equal(event?.beforeSha, null);
    assert.equal(event?.commits.length, 1);
  });

  it("reports a new branch with no new commits using only the head commit's message", async () => {
    const t = setup();
    await t.poll();
    t.repo.branches.push({ name: "feature/empty", sha: sha(1) });
    t.repo.etag = 'W/"etag-2"';
    t.repo.commits.set(sha(1), { ...commit(1, "chore: init", "bob"), files: [{ path: "README.md", status: "added" }] });

    await t.poll();

    const [event] = queryEvents(t.db).events;
    assert.equal(event?.eventType, "create");
    assert.equal(event?.headMessage, "chore: init");
    assert.deepEqual(event?.commits, []);
    assert.deepEqual(event?.files, [], "the default branch's own files are not this branch's change");
  });

  it("reports a deleted branch and forgets its head", async () => {
    const t = setup();
    await t.poll();
    t.repo.branches = [{ name: "main", sha: sha(1) }];
    t.repo.etag = 'W/"etag-2"';

    await t.poll();

    const [event] = queryEvents(t.db).events;
    assert.equal(event?.eventType, "delete");
    assert.equal(event?.branch, "dev");
    assert.equal(event?.afterSha, sha(2));
    assert.equal(event?.pusher, null);
    assert.equal(getHeads(t.db, t.project.id).has("dev"), false);
  });

  it("falls back to the head commit when the old SHA is gone (force push)", async () => {
    const t = setup();
    await t.poll();
    t.repo.branches = [{ name: "main", sha: sha(10) }, { name: "dev", sha: sha(2) }];
    t.repo.etag = 'W/"etag-2"';
    t.repo.commits.set(sha(10), { ...commit(10, "fix: rewritten", "carol"), files: [{ path: "x.ts", status: "added" }] });

    await t.poll();

    const [event] = queryEvents(t.db).events;
    assert.equal(event?.afterSha, sha(10));
    assert.equal(event?.pusher, "carol");
    assert.deepEqual(event?.files, [{ path: "x.ts", status: "added" }]);
  });

  it("does not infer deletions when the branch listing was truncated", async () => {
    const t = setup();
    await t.poll();
    t.repo.branches = [{ name: "main", sha: sha(1) }];
    t.repo.etag = 'W/"etag-2"';
    t.repo.truncated = true;

    await t.poll();

    assert.equal(queryEvents(t.db).events.length, 0);
    assert.equal(getHeads(t.db, t.project.id).has("dev"), true);
  });
});

describe("branch filter", () => {
  it("only tracks and reports matching branches", async () => {
    const t = setup(["main"]);
    await t.poll();
    assert.deepEqual([...getHeads(t.db, t.project.id).keys()], ["main"]);

    t.repo.branches = [{ name: "main", sha: sha(1) }, { name: "dev", sha: sha(99) }];
    t.repo.etag = 'W/"etag-2"';
    await t.poll();

    assert.equal(queryEvents(t.db).events.length, 0);
  });
});

describe("failure handling", () => {
  it("keeps progress made before a failure and retries only the rest", async () => {
    const t = setup();
    await t.poll();
    t.repo.branches = [{ name: "dev", sha: sha(30) }, { name: "main", sha: sha(10) }];
    t.repo.etag = 'W/"etag-2"';
    withCompare(t.repo, 2, 30);
    withCompare(t.repo, 1, 10);
    // main 的 compare 暫時失敗；dev 依名稱排在前面，會先處理成功。
    const failingHeads = new Set([sha(10)]);
    const originalCompare = t.fake.client.compare;
    t.fake.client.compare = async (owner, repoName, base, head) => {
      if (failingHeads.has(head)) {
        throw new GithubApiError("network");
      }
      return originalCompare(owner, repoName, base, head);
    };

    await assert.rejects(t.poll(), (error) => error instanceof GithubApiError && error.kind === "network");

    assert.equal(queryEvents(t.db).events.length, 1, "dev was already reported");
    assert.equal(getHeads(t.db, t.project.id).get("dev"), sha(30));
    assert.equal(getHeads(t.db, t.project.id).get("main"), sha(1), "main will be retried");
    assert.notEqual(getPollMeta(t.db, t.project.id).etag, 'W/"etag-2"', "the new ETag must not be stored yet");

    // 恢復後下一輪只補 main，dev 不會重複。
    failingHeads.clear();
    await t.poll();

    const events = queryEvents(t.db).events;
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((e) => e.branch).sort(), ["dev", "main"]);
  });

  it("does not save the baseline when the listing itself fails", async () => {
    const t = setup();
    t.repo.failures.list = new GithubApiError("auth", 401);

    await assert.rejects(t.poll());

    assert.equal(getPollMeta(t.db, t.project.id).baselineDone, false);
    assert.equal(getHeads(t.db, t.project.id).size, 0);
  });
});

describe("large bursts", () => {
  it("processes at most MAX_CHANGES_PER_POLL branches per poll and finishes on the next", async () => {
    const t = setup();
    await t.poll();
    const total = MAX_CHANGES_PER_POLL + 5;
    t.repo.branches = [];
    for (let i = 0; i < total; i += 1) {
      const name = `feature/${String(i).padStart(2, "0")}`;
      t.repo.branches.push({ name, sha: sha(100 + i) });
      t.repo.commits.set(sha(100 + i), { ...commit(100 + i, `feat: ${i}`), files: [] });
    }
    t.repo.branches.push({ name: "main", sha: sha(1) }, { name: "dev", sha: sha(2) });
    t.repo.etag = 'W/"etag-2"';

    const first = await t.poll();
    assert.equal(first.eventsInserted, MAX_CHANGES_PER_POLL);
    assert.equal(first.incomplete, true);
    assert.notEqual(getPollMeta(t.db, t.project.id).etag, 'W/"etag-2"');

    const second = await t.poll();
    assert.equal(second.eventsInserted, 5);
    assert.equal(second.incomplete, false);
    assert.equal(getPollMeta(t.db, t.project.id).etag, 'W/"etag-2"');
    assert.equal(queryEvents(t.db, { limit: 200 }).events.length, total);
  });
});
