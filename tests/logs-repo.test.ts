import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { queryLogs } from "@main/db/logs-repo";
import { appendLog } from "@main/logger";
import { createTestDb } from "./helpers/db";

const seed = () => {
  const db = createTestDb();
  appendLog(db, { category: "push", level: "info", message: "acme/api：已建立監視基準" }, 1000);
  appendLog(db, { category: "push", level: "warn", message: "acme/api：無法連線到 GitHub" }, 2000);
  appendLog(db, { category: "rule", level: "info", message: "規則 notify 已執行 100%", detail: { status: "success" } }, 3000);
  appendLog(db, { category: "command", level: "error", message: "git pull 失敗" }, 4000);
  return db;
};

describe("queryLogs", () => {
  it("returns newest first with parsed detail", () => {
    const { logs } = queryLogs(seed());
    assert.deepEqual(logs.map((log) => log.ts), [4000, 3000, 2000, 1000]);
    assert.deepEqual(logs[1]?.detail, { status: "success" });
    assert.equal(logs[0]?.detail, null);
  });

  it("filters by category, level and time range", () => {
    const db = seed();
    assert.equal(queryLogs(db, { category: "push" }).logs.length, 2);
    assert.equal(queryLogs(db, { level: "error" }).logs.length, 1);
    assert.equal(queryLogs(db, { category: "push", level: "warn" }).logs.length, 1);
    assert.equal(queryLogs(db, { fromMs: 2000, toMs: 3000 }).logs.length, 2);
  });

  it("searches message text literally", () => {
    const db = seed();
    assert.equal(queryLogs(db, { search: "GitHub" }).logs.length, 1);
    assert.equal(queryLogs(db, { search: "100%" }).logs.length, 1);
    assert.equal(queryLogs(db, { search: "%" }).logs.length, 1);
    assert.equal(queryLogs(db, { search: "acme/api" }).logs.length, 2);
  });

  it("paginates", () => {
    const db = seed();
    const first = queryLogs(db, { limit: 3 });
    assert.equal(first.logs.length, 3);
    assert.equal(first.hasMore, true);
    const second = queryLogs(db, { limit: 3, offset: 3 });
    assert.equal(second.logs.length, 1);
    assert.equal(second.hasMore, false);
  });
});
