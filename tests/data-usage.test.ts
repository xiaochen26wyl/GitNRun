import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readDataUsage } from "@main/db/data-usage";
import { insertEvent } from "@main/db/events-repo";
import type { Db } from "@main/db/database";
import { createTestDb, makeEvent, seedProject } from "./helpers/db";

const addLog = (db: Db, ts: number): void => {
  db.prepare("INSERT INTO logs (ts, category, level, message) VALUES (?, 'system', 'info', 'hello')").run(ts);
};

const addAiCall = (db: Db, ts: number): void => {
  db.prepare(
    "INSERT INTO ai_calls (ts, provider, model, purpose, input_hash, status, response_text) VALUES (?, 'p', 'm', 'x', 'h', 'ok', 'reply')"
  ).run(ts);
};

describe("readDataUsage", () => {
  it("reports empty tables as zero rows with no oldest time", () => {
    const usage = readDataUsage(createTestDb());
    for (const category of [usage.events, usage.logs, usage.aiCalls]) {
      assert.equal(category.count, 0);
      assert.equal(category.oldestAt, null);
    }
    assert.ok(usage.databaseBytes > 0);
    assert.ok(usage.freeBytes >= 0);
  });

  it("counts rows and finds the oldest timestamp per category", () => {
    const db = createTestDb();
    const projectId = seedProject(db);
    insertEvent(db, makeEvent(projectId, { occurredAt: 3_000 }));
    insertEvent(db, makeEvent(projectId, { occurredAt: 1_000 }));
    addLog(db, 500);
    addLog(db, 900);
    addLog(db, 700);
    addAiCall(db, 42);

    const usage = readDataUsage(db);
    assert.deepEqual([usage.events.count, usage.events.oldestAt], [2, 1_000]);
    assert.deepEqual([usage.logs.count, usage.logs.oldestAt], [3, 500]);
    assert.deepEqual([usage.aiCalls.count, usage.aiCalls.oldestAt], [1, 42]);
  });

  it("measures space per category, and events include rule executions", () => {
    const db = createTestDb();
    const before = readDataUsage(db);
    const projectId = seedProject(db);
    const { id } = insertEvent(db, makeEvent(projectId));
    for (let i = 0; i < 200; i += 1) {
      db.prepare("INSERT INTO rule_executions (rule_name, event_id, status, started_at, detail_json) VALUES ('r', ?, 'ok', ?, ?)").run(
        id,
        i,
        "x".repeat(500)
      );
      addLog(db, i);
    }

    const after = readDataUsage(db);
    assert.ok(typeof after.events.bytes === "number" && typeof before.events.bytes === "number");
    assert.ok(after.events.bytes > before.events.bytes, "rule_executions should count toward events");
    assert.ok((after.logs.bytes ?? 0) > (before.logs.bytes ?? 0));
  });

  it("leaves bytes null but keeps everything else when dbstat is unavailable", () => {
    const db = createTestDb();
    addLog(db, 1);
    const noDbstat = new Proxy(db, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            if (sql.includes("dbstat")) throw new Error("no such table: dbstat");
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
    });

    const usage = readDataUsage(noDbstat);
    assert.equal(usage.logs.bytes, null);
    assert.equal(usage.events.bytes, null);
    assert.equal(usage.logs.count, 1);
    assert.ok(usage.databaseBytes > 0);
  });
});
