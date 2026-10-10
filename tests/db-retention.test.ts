import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { insertEvent } from "@main/db/events-repo";
import { DAY_MS, clampRetentionDays, purgeExpired } from "@main/db/retention";
import { createTestDb, makeEvent, seedProject } from "./helpers/db";

const NOW = 1_800_000_000_000;

const count = (db: ReturnType<typeof createTestDb>, table: string): number =>
  Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);

describe("purgeExpired", () => {
  it("deletes only expired events, logs and ai_calls", () => {
    const db = createTestDb();
    const projectId = seedProject(db);
    insertEvent(db, makeEvent(projectId, { occurredAt: NOW - 40 * DAY_MS }));
    insertEvent(db, makeEvent(projectId, { occurredAt: NOW - 29 * DAY_MS }));
    db.prepare("INSERT INTO logs (ts, category, message) VALUES (?, 'system', 'old')").run(NOW - 31 * DAY_MS);
    db.prepare("INSERT INTO logs (ts, category, message) VALUES (?, 'system', 'new')").run(NOW - DAY_MS);
    db.prepare(
      "INSERT INTO ai_calls (ts, provider, model, purpose, input_hash, status) VALUES (?, 'x', 'm', 'p', 'h', 'ok')"
    ).run(NOW - 45 * DAY_MS);

    const result = purgeExpired(db, { retentionDays: 30, now: NOW });

    assert.deepEqual(result, { events: 1, logs: 1, aiCalls: 1 });
    assert.equal(count(db, "push_events"), 1);
    assert.equal(count(db, "logs"), 1);
    assert.equal(count(db, "ai_calls"), 0);
  });

  it("removes rule executions together with their events", () => {
    const db = createTestDb();
    const projectId = seedProject(db);
    const { id: oldId } = insertEvent(db, makeEvent(projectId, { occurredAt: NOW - 40 * DAY_MS }));
    const { id: freshId } = insertEvent(db, makeEvent(projectId, { occurredAt: NOW - DAY_MS }));
    const insertExecution = db.prepare(
      "INSERT INTO rule_executions (rule_name, event_id, status, started_at) VALUES ('r', ?, 'success', 0)"
    );
    insertExecution.run(oldId);
    insertExecution.run(freshId);

    purgeExpired(db, { retentionDays: 30, now: NOW });

    assert.equal(count(db, "rule_executions"), 1);
  });

  it("works in batches without missing rows", () => {
    const db = createTestDb();
    const projectId = seedProject(db);
    for (let i = 0; i < 7; i += 1) {
      insertEvent(db, makeEvent(projectId, { occurredAt: NOW - (40 + i) * DAY_MS }));
    }
    insertEvent(db, makeEvent(projectId, { occurredAt: NOW }));

    const result = purgeExpired(db, { retentionDays: 30, now: NOW, batchSize: 2 });

    assert.equal(result.events, 7);
    assert.equal(count(db, "push_events"), 1);
  });

  it("keeps everything when retention is null", () => {
    const db = createTestDb();
    const projectId = seedProject(db);
    insertEvent(db, makeEvent(projectId, { occurredAt: NOW - 4000 * DAY_MS }));

    assert.deepEqual(purgeExpired(db, { retentionDays: null, now: NOW }), { events: 0, logs: 0, aiCalls: 0 });
    assert.equal(count(db, "push_events"), 1);
  });
});

describe("clampRetentionDays", () => {
  it("keeps values in a sane range", () => {
    assert.equal(clampRetentionDays(0), 1);
    assert.equal(clampRetentionDays(-5), 1);
    assert.equal(clampRetentionDays(30.9), 30);
    assert.equal(clampRetentionDays(100_000), 3650);
  });
});
