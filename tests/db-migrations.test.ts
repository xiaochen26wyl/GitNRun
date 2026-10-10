import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openDatabase, MEMORY_DB } from "@main/db/database";
import {
  LATEST_SCHEMA_VERSION,
  SchemaTooNewError,
  getSchemaVersion,
  migrate,
  type Migration
} from "@main/db/migrations";
import { createTestDb, makeEvent, seedProject } from "./helpers/db";
import { insertEvent } from "@main/db/events-repo";

const tableNames = (db: ReturnType<typeof createTestDb>): string[] =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => String(row.name));

describe("migrate", () => {
  it("builds the full schema from an empty database", () => {
    const db = openDatabase(MEMORY_DB);
    const result = migrate(db);
    assert.deepEqual(result, { from: 0, to: LATEST_SCHEMA_VERSION });
    assert.equal(getSchemaVersion(db), LATEST_SCHEMA_VERSION);

    const tables = tableNames(db);
    for (const expected of [
      "projects",
      "webhooks",
      "push_events",
      "rules",
      "rule_executions",
      "terminal_mappings",
      "api_keys",
      "logs",
      "settings",
      "branch_rules",
      "ai_calls",
      "poll_state",
      "poll_meta",
      "rule_self_events",
      "webhook_deliveries"
    ]) {
      assert.ok(tables.includes(expected), `missing table ${expected}`);
    }
  });

  it("is a no-op when run again", () => {
    const db = createTestDb();
    const before = tableNames(db);
    const result = migrate(db);
    assert.deepEqual(result, { from: LATEST_SCHEMA_VERSION, to: LATEST_SCHEMA_VERSION });
    assert.deepEqual(tableNames(db), before);
  });

  it("refuses a database written by a newer app", () => {
    const db = createTestDb();
    db.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    assert.throws(() => migrate(db), SchemaTooNewError);
  });

  it("rolls a failing migration back completely", () => {
    const db = openDatabase(MEMORY_DB);
    const migrations: Migration[] = [
      { version: 1, name: "ok", sql: "CREATE TABLE a (id INTEGER)" },
      { version: 2, name: "broken", sql: "CREATE TABLE b (id INTEGER); CREATE TABLE a (id INTEGER)" }
    ];
    assert.throws(() => migrate(db, migrations));
    assert.equal(getSchemaVersion(db), 1);
    const tables = tableNames(db as ReturnType<typeof createTestDb>);
    assert.ok(tables.includes("a"));
    assert.ok(!tables.includes("b"), "partial migration must not leak table b");
  });

  it("rejects non-sequential migration versions", () => {
    const db = openDatabase(MEMORY_DB);
    assert.throws(() => migrate(db, [{ version: 2, name: "skips v1", sql: "CREATE TABLE a (id INTEGER)" }]));
  });
});

describe("schema constraints", () => {
  it("cascades project deletion to events and branch rules", () => {
    const db = createTestDb();
    const projectId = seedProject(db);
    insertEvent(db, makeEvent(projectId));
    db.prepare(
      "INSERT INTO branch_rules (project_id, template, created_at, updated_at) VALUES (?, 'v{version}', 0, 0)"
    ).run(projectId);

    db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);

    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM push_events").get()?.n), 0);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM branch_rules").get()?.n), 0);
  });

  it("rejects an invalid project mode", () => {
    const db = createTestDb();
    assert.throws(() =>
      db
        .prepare("INSERT INTO projects (name, owner, repo, mode, created_at) VALUES ('x', 'a', 'b', 'bogus', 0)")
        .run()
    );
  });

  it("keeps rule execution history when its rule is deleted", () => {
    const db = createTestDb();
    const projectId = seedProject(db);
    const { id: eventId } = insertEvent(db, makeEvent(projectId));
    const rule = db
      .prepare("INSERT INTO rules (name, created_at, updated_at) VALUES ('r', 0, 0)")
      .run();
    db.prepare(
      "INSERT INTO rule_executions (rule_id, rule_name, event_id, status, started_at) VALUES (?, 'r', ?, 'success', 0)"
    ).run(Number(rule.lastInsertRowid), eventId);

    db.prepare("DELETE FROM rules").run();

    const row = db.prepare("SELECT rule_id, rule_name FROM rule_executions").get();
    assert.equal(row?.rule_id, null);
    assert.equal(row?.rule_name, "r");
  });
});
