import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPushEvent, detectBranchChanges, filterBranches, firstLine } from "@main/monitor/changes";
import { commit, sha } from "./helpers/fake-github";

describe("detectBranchChanges", () => {
  const previous = new Map([["main", sha(1)], ["dev", sha(2)], ["old", sha(3)]]);

  it("finds created, updated and deleted branches, sorted by name", () => {
    const changes = detectBranchChanges(
      previous,
      [{ name: "main", sha: sha(10) }, { name: "dev", sha: sha(2) }, { name: "feature/x", sha: sha(5) }],
      { allowDeletes: true }
    );
    assert.deepEqual(changes, [
      { kind: "deleted", branch: "old", beforeSha: sha(3), afterSha: null },
      { kind: "created", branch: "feature/x", beforeSha: null, afterSha: sha(5) },
      { kind: "updated", branch: "main", beforeSha: sha(1), afterSha: sha(10) }
    ].sort((a, b) => (a.branch < b.branch ? -1 : 1)));
  });

  it("reports nothing when nothing moved", () => {
    assert.deepEqual(
      detectBranchChanges(previous, [{ name: "main", sha: sha(1) }, { name: "dev", sha: sha(2) }, { name: "old", sha: sha(3) }], { allowDeletes: true }),
      []
    );
  });

  it("does not infer deletions from a truncated listing", () => {
    const changes = detectBranchChanges(previous, [{ name: "main", sha: sha(1) }], { allowDeletes: false });
    assert.deepEqual(changes, []);
  });
});

describe("filterBranches", () => {
  const branches = [{ name: "main", sha: sha(1) }, { name: "feature/login", sha: sha(2) }, { name: "v010_2026_1009", sha: sha(3) }];

  it("keeps everything for the default '*' filter, including names with slashes", () => {
    assert.equal(filterBranches(branches, ["*"]).length, 3);
  });

  it("applies glob filters", () => {
    assert.deepEqual(filterBranches(branches, ["main", "feature/*"]).map((b) => b.name), ["main", "feature/login"]);
    assert.deepEqual(filterBranches(branches, ["v???_????_????"]).map((b) => b.name), ["v010_2026_1009"]);
  });
});

describe("buildPushEvent", () => {
  const head = commit(9, "feat: add login\n\nlong body", "alice");

  it("builds a push event with an inferred pusher and detection time", () => {
    const event = buildPushEvent({
      projectId: 3,
      change: { kind: "updated", branch: "main", beforeSha: sha(1), afterSha: sha(9) },
      commits: [head],
      files: [{ path: "a.ts", status: "modified" }],
      headCommit: head,
      now: 5000
    });

    assert.equal(event.eventType, "push");
    assert.equal(event.ref, "refs/heads/main");
    assert.equal(event.afterSha, sha(9));
    assert.equal(event.beforeSha, sha(1));
    assert.equal(event.pusher, "alice");
    assert.equal(event.pusherInferred, true);
    assert.equal(event.headMessage, "feat: add login");
    assert.equal(event.fileCount, 1);
    assert.equal(event.source, "poll");
    assert.equal(event.occurredAt, 5000);
  });

  it("uses the pre-delete head as the idempotency SHA for deletions and has no pusher", () => {
    const event = buildPushEvent({
      projectId: 3,
      change: { kind: "deleted", branch: "old", beforeSha: sha(3), afterSha: null },
      commits: [],
      files: [],
      headCommit: null,
      now: 1
    });
    assert.equal(event.eventType, "delete");
    assert.equal(event.afterSha, sha(3));
    assert.equal(event.pusher, null);
    assert.equal(event.headMessage, "");
  });

  it("marks branch creation", () => {
    const event = buildPushEvent({
      projectId: 3,
      change: { kind: "created", branch: "feature/x", beforeSha: null, afterSha: sha(9) },
      commits: [],
      files: [],
      headCommit: head,
      now: 1
    });
    assert.equal(event.eventType, "create");
    assert.equal(event.beforeSha, null);
  });
});

describe("firstLine", () => {
  it("keeps only the subject and bounds its length", () => {
    assert.equal(firstLine("subject\n\nbody"), "subject");
    assert.equal(firstLine("  padded  "), "padded");
    assert.equal(firstLine("x".repeat(500)).length, 200);
    assert.equal(firstLine(""), "");
  });
});
