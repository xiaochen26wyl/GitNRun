import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_LOG_DETAIL, MAX_LOG_MESSAGE, appendLog } from "@main/logger";
import { createTestDb } from "./helpers/db";

const TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

describe("appendLog", () => {
  it("redacts message and detail before they reach the database", () => {
    const db = createTestDb();
    appendLog(
      db,
      {
        category: "command",
        level: "error",
        message: `git push failed using ${TOKEN}`,
        detail: { stderr: `remote: bad credentials ${TOKEN}`, headers: { Authorization: `Bearer ${TOKEN}` }, exit: 1 }
      },
      1234
    );

    const row = db.prepare("SELECT * FROM logs").get();
    assert.ok(row);
    const everything = JSON.stringify(row);
    assert.ok(!everything.includes(TOKEN));
    assert.equal(row.ts, 1234);
    assert.equal(row.category, "command");
    assert.equal(JSON.parse(String(row.detail_json)).exit, 1);
  });

  it("truncates long messages and keeps oversized details valid JSON", () => {
    const db = createTestDb();
    appendLog(db, {
      category: "system",
      level: "info",
      message: "x".repeat(MAX_LOG_MESSAGE * 2),
      detail: { blob: "y".repeat(MAX_LOG_DETAIL * 2) }
    });

    const row = db.prepare("SELECT message, detail_json FROM logs").get();
    assert.ok(row);
    assert.ok(String(row.message).length <= MAX_LOG_MESSAGE + 20);
    const detail = JSON.parse(String(row.detail_json));
    assert.equal(detail.truncated, true);
  });

  it("stores null detail when none is given", () => {
    const db = createTestDb();
    appendLog(db, { category: "push", level: "info", message: "hello" });
    assert.equal(db.prepare("SELECT detail_json FROM logs").get()?.detail_json, null);
  });
});
