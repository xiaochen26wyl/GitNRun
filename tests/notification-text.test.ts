import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PushEvent } from "@shared/events";
import { formatNotification } from "@main/monitor/notification-text";

const project = { name: "acme/widgets" };

const event = (overrides: Partial<PushEvent> = {}): PushEvent => ({
  id: 1,
  projectId: 1,
  eventType: "push",
  ref: "refs/heads/main",
  branch: "main",
  beforeSha: "a".repeat(40),
  afterSha: "b".repeat(40),
  pusher: "alice",
  pusherInferred: true,
  headMessage: "feat: add login",
  commits: [],
  files: [],
  fileCount: 3,
  branchViolation: false,
  source: "poll",
  occurredAt: 0,
  createdAt: 0,
  ...overrides
});

describe("formatNotification", () => {
  it("shows project, branch, an 'inferred' pusher and the commit subject", () => {
    assert.deepEqual(formatNotification(project, event()), {
      title: "acme/widgets · main",
      body: "alice（推定）：feat: add login"
    });
  });

  it("does not mark a confirmed pusher as inferred", () => {
    assert.equal(formatNotification(project, event({ pusherInferred: false })).body, "alice：feat: add login");
  });

  it("falls back to the file count and mentions multiple commits", () => {
    const body = formatNotification(project, event({ headMessage: "", pusher: null, commits: [{} as never, {} as never] })).body;
    assert.equal(body, "有人：3 個檔案變更（共 2 個 commit）");
  });

  it("describes branch creation and deletion", () => {
    assert.equal(formatNotification(project, event({ eventType: "create", headMessage: "wip" })).body, "新分支：wip");
    assert.equal(formatNotification(project, event({ eventType: "create", headMessage: "" })).body, "新分支");
    assert.equal(formatNotification(project, event({ eventType: "delete" })).body, "分支已被刪除");
  });

  it("warns about a branch name that breaks the naming rule", () => {
    const body = formatNotification(project, event({ branchViolation: true })).body;
    assert.ok(body.startsWith("⚠ 分支名稱不符規則\n"));
  });
});
