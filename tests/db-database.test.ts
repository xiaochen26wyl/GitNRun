import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { inTransaction, openDatabase } from "@main/db/database";
import { migrate } from "@main/db/migrations";
import { getSetting, listSettings, setSetting } from "@main/db/settings-repo";

const root = mkdtempSync(join(tmpdir(), "gitnrun-db-"));
after(() => rmSync(root, { recursive: true, force: true }));

describe("openDatabase", () => {
  it("creates an owner-only database in an owner-only directory", () => {
    const dir = join(root, "data");
    const path = join(dir, "gitnrun.db");
    const db = openDatabase(path);
    migrate(db);
    setSetting(db, "k", 1);

    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(path + suffix)) {
        assert.equal(statSync(path + suffix).mode & 0o777, 0o600, `${suffix} permissions`);
      }
    }
    db.close();
  });

  it("enables WAL, foreign keys and a busy timeout", () => {
    const db = openDatabase(join(root, "pragmas.db"));
    assert.equal(db.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
    assert.equal(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
    assert.equal(db.prepare("PRAGMA busy_timeout").get()?.timeout, 5000);
    db.close();
  });

  it("re-tightens permissions on an existing database file", () => {
    const path = join(root, "loose.db");
    openDatabase(path).close();
    chmodSync(path, 0o644);
    openDatabase(path).close();
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});

describe("inTransaction", () => {
  it("rolls back when the callback throws", () => {
    const db = openDatabase(join(root, "tx.db"));
    migrate(db);
    assert.throws(() =>
      inTransaction(db, () => {
        setSetting(db, "a", 1);
        throw new Error("boom");
      })
    );
    assert.equal(getSetting(db, "a", "missing"), "missing");
    db.close();
  });
});

describe("settings repo", () => {
  it("stores JSON values and upserts", () => {
    const db = openDatabase(join(root, "settings.db"));
    migrate(db);
    setSetting(db, "retention.days", 30);
    setSetting(db, "retention.days", 7);
    setSetting(db, "ui", { view: "table" });

    assert.equal(getSetting(db, "retention.days", 0), 7);
    assert.deepEqual(getSetting(db, "ui", {}), { view: "table" });
    assert.equal(getSetting(db, "nope", "fallback"), "fallback");
    assert.deepEqual(
      listSettings(db).map((entry) => entry.key),
      ["retention.days", "ui"]
    );
    db.close();
  });
});
