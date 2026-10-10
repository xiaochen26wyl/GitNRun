import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getEvent, insertEvent, queryEvents } from "@main/db/events-repo";
import { inTransaction } from "@main/db/database";
import { createTestDb, makeEvent, seedProject } from "./helpers/db";

describe("insertEvent idempotency", () => {
  it("keeps one row when poll and webhook report the same push", () => {
    const db = createTestDb();
    const projectId = seedProject(db);
    const poll = makeEvent(projectId, { source: "poll", pusherInferred: true });
    const webhook = { ...poll, source: "webhook" as const, pusherInferred: false, pusher: "real-pusher" };

    const first = insertEvent(db, poll);
    const second = insertEvent(db, webhook);

    assert.equal(first.inserted, true);
    assert.equal(second.inserted, false);
    assert.equal(second.id, first.id);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM push_events").get()?.n), 1);
  });

  it("treats the same SHA on a different ref or event type as a distinct event", () => {
    const db = createTestDb();
    const projectId = seedProject(db);
    const base = makeEvent(projectId);

    assert.equal(insertEvent(db, base).inserted, true);
    assert.equal(insertEvent(db, { ...base, ref: "refs/heads/other", branch: "other" }).inserted, true);
    assert.equal(insertEvent(db, { ...base, eventType: "delete" }).inserted, true);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM push_events").get()?.n), 3);
  });

  it("round-trips commits, files and flags", () => {
    const db = createTestDb();
    const projectId = seedProject(db);
    const event = makeEvent(projectId, {
      commits: [{ sha: "a".repeat(40), message: "feat: x", author: "octocat", timestamp: 1 }],
      files: [{ path: "src/a.ts", status: "modified" }],
      fileCount: 1,
      branchViolation: true
    });
    const { id } = insertEvent(db, event);

    const stored = getEvent(db, id);
    assert.ok(stored);
    assert.deepEqual(stored.commits, event.commits);
    assert.deepEqual(stored.files, event.files);
    assert.equal(stored.branchViolation, true);
    assert.equal(stored.pusherInferred, true);
  });
});

describe("queryEvents", () => {
  const seed = () => {
    const db = createTestDb();
    const a = seedProject(db, "acme", "api");
    const b = seedProject(db, "acme", "web");
    insertEvent(db, makeEvent(a, { branch: "main", ref: "refs/heads/main", pusher: "alice", occurredAt: 1000, headMessage: "fix: login" }));
    insertEvent(db, makeEvent(a, { branch: "v010_2026_1009", ref: "refs/heads/v010_2026_1009", pusher: "bob", occurredAt: 2000, headMessage: "feat: 100% coverage" }));
    insertEvent(db, makeEvent(b, { branch: "main", ref: "refs/heads/main", pusher: "alice", occurredAt: 3000, headMessage: "chore: deps", branchViolation: true }));
    return { db, a, b };
  };

  it("returns newest first", () => {
    const { db } = seed();
    const { events } = queryEvents(db);
    assert.deepEqual(
      events.map((event) => event.occurredAt),
      [3000, 2000, 1000]
    );
  });

  it("filters by project, branch, pusher and time range", () => {
    const { db, a } = seed();
    assert.equal(queryEvents(db, { projectId: a }).events.length, 2);
    assert.equal(queryEvents(db, { branch: "main" }).events.length, 2);
    assert.equal(queryEvents(db, { pusher: "bob" }).events.length, 1);
    assert.equal(queryEvents(db, { fromMs: 1500, toMs: 2500 }).events.length, 1);
    assert.equal(queryEvents(db, { branchViolationOnly: true }).events.length, 1);
    assert.equal(queryEvents(db, { projectId: a, branch: "main", pusher: "alice" }).events.length, 1);
  });

  it("searches message, branch, pusher and sha as literal text", () => {
    const { db } = seed();
    assert.equal(queryEvents(db, { search: "login" }).events.length, 1);
    assert.equal(queryEvents(db, { search: "v010_2026" }).events.length, 1);
    assert.equal(queryEvents(db, { search: "alice" }).events.length, 2);
    // % 與 _ 是字面字元，不是萬用字元。
    assert.equal(queryEvents(db, { search: "100%" }).events.length, 1);
    assert.equal(queryEvents(db, { search: "%" }).events.length, 1);
    assert.equal(queryEvents(db, { search: "v010_2026_1009" }).events.length, 1);
    assert.equal(queryEvents(db, { search: "v010X2026" }).events.length, 0);
  });

  it("paginates and reports whether more rows exist", () => {
    const { db } = seed();
    const first = queryEvents(db, { limit: 2 });
    assert.equal(first.events.length, 2);
    assert.equal(first.hasMore, true);

    const second = queryEvents(db, { limit: 2, offset: 2 });
    assert.equal(second.events.length, 1);
    assert.equal(second.hasMore, false);
  });

  it("clamps absurd limits", () => {
    const { db } = seed();
    assert.equal(queryEvents(db, { limit: 10_000 }).events.length, 3);
    assert.equal(queryEvents(db, { limit: -5 }).events.length, 1);
  });
});

describe("query performance", () => {
  it("answers filtered and search queries in under 100ms with 100k events", () => {
    const db = createTestDb();
    const projects = [seedProject(db, "acme", "a"), seedProject(db, "acme", "b"), seedProject(db, "acme", "c")];
    const branches = ["main", "develop", "v010_2026_1009", "feature/x"];
    const pushers = ["alice", "bob", "carol", "dave", "erin"];

    const insert = db.prepare(
      `INSERT INTO push_events (project_id, event_type, ref, branch, before_sha, after_sha, pusher, pusher_inferred,
         head_message, commits_json, files_json, file_count, branch_violation, source, occurred_at, created_at)
       VALUES (?, 'push', ?, ?, NULL, ?, ?, 1, ?, '[]', '[]', 0, 0, 'poll', ?, 0)`
    );
    inTransaction(db, () => {
      for (let i = 0; i < 100_000; i += 1) {
        const branch = branches[i % branches.length] as string;
        insert.run(
          projects[i % projects.length] as number,
          `refs/heads/${branch}`,
          branch,
          i.toString(16).padStart(40, "0"),
          pushers[i % pushers.length] as string,
          `feat: change number ${i}`,
          1_700_000_000_000 + i * 1000
        );
      }
    });

    const timed = (label: string, run: () => void): void => {
      run(); // 預熱
      const start = performance.now();
      run();
      const elapsed = performance.now() - start;
      assert.ok(elapsed < 100, `${label} took ${elapsed.toFixed(1)}ms`);
    };

    timed("by project + time", () => queryEvents(db, { projectId: projects[0] as number, limit: 50 }));
    timed("by branch", () => queryEvents(db, { branch: "v010_2026_1009", limit: 50 }));
    timed("by pusher", () => queryEvents(db, { pusher: "carol", limit: 50 }));
    timed("by time range", () =>
      queryEvents(db, { fromMs: 1_700_000_000_000 + 50_000_000, toMs: 1_700_000_000_000 + 60_000_000 })
    );
    timed("text search", () => queryEvents(db, { search: "number 99999" }));
  });
});
