import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  BackupValidationError,
  BACKUP_KEEP,
  exportConfig,
  importConfig,
  isSecretLikeSettingKey,
  listBackups,
  parseBackup,
  readBackupFile,
  writeBackup,
  MAX_BACKUP_BYTES
} from "@main/db/backup";
import { insertEvent } from "@main/db/events-repo";
import { setSetting } from "@main/db/settings-repo";
import { createTestDb, makeEvent, seedProject } from "./helpers/db";
import type { Db } from "@main/db/database";

const tempDirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "gitnrun-backup-"));
  tempDirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const SECRET_CIPHERTEXT = "AAECAwQFBgcICQoLDA0ODw==SECRET-CIPHERTEXT";

const populate = (db: Db): void => {
  const projectId = seedProject(db, "acme", "widgets");
  db.prepare("UPDATE projects SET local_path = '/Users/me/widgets', mode = 'both', ai_enabled = 1 WHERE id = ?").run(projectId);
  db.prepare(
    "INSERT INTO branch_rules (project_id, template, version_source, created_at, updated_at) VALUES (0, 'v{version}_{year}_{mmdd}', 'package.json', 0, 0)"
  ).run();
  db.prepare(
    "INSERT INTO branch_rules (project_id, template, version_source, created_at, updated_at) VALUES (?, '{user}/{slug}', 'VERSION', 0, 0)"
  ).run(projectId);
  db.prepare(
    `INSERT INTO rules (name, enabled, priority, match_mode, conditions_json, actions_json, cooldown_sec, skip_confirm, created_at, updated_at)
     VALUES ('notify on main', 1, 10, 'all', '[{"type":"branch","patterns":["main"]}]', '[{"type":"notify_system"},{"type":"shell","command":"echo hi","timeoutSec":30,"env":[],"secretEnvNames":[],"retries":0,"retryDelaySec":5}]', 30, 1, 0, 0)`
  ).run();
  db.prepare(
    "INSERT INTO terminal_mappings (path_pattern, command, recursive, terminal_app, created_at, updated_at) VALUES ('/Users/me/*', 'pnpm dev', 1, 'terminal', 0, 0)"
  ).run();
  setSetting(db, "retention.days", 14);
  setSetting(db, "github.token", "ghp_shouldNeverBeBackedUp");
  db.prepare("INSERT INTO api_keys (name, ciphertext, hint, created_at, updated_at) VALUES ('github.pat', ?, 'wxyz', 0, 0)").run(SECRET_CIPHERTEXT);
};

describe("exportConfig", () => {
  it("contains config but never keys, ciphertext or secret-like settings", () => {
    const db = createTestDb();
    populate(db);

    const json = JSON.stringify(exportConfig(db));

    assert.ok(json.includes("notify on main"));
    assert.ok(json.includes("/Users/me/*"));
    assert.ok(json.includes("retention.days"));
    assert.ok(!json.includes(SECRET_CIPHERTEXT));
    assert.ok(!json.includes("api_keys"));
    assert.ok(!json.includes("wxyz"), "key hint must not leak into backups");
    assert.ok(!json.includes("ghp_shouldNeverBeBackedUp"));
    assert.ok(!json.includes("github.token"));
  });
});

describe("run page settings", () => {
  it("never puts the trusted start commands into a backup, and refuses them on import", () => {
    const db = createTestDb();
    setSetting(db, "run.trusted", { "/Users/me/app": "a".repeat(64) });
    setSetting(db, "run.folders", [{ id: 1, path: "/Users/me/app" }]);

    const backup = exportConfig(db);
    const keys = backup.settings.map((setting) => setting.key);
    assert.ok(!keys.includes("run.trusted"));
    assert.ok(keys.includes("run.folders"));
    assert.equal(isSecretLikeSettingKey("run.trusted"), true);
    assert.equal(isSecretLikeSettingKey("run.folders"), false);
  });

  it("keeps the dev accounts out of a backup like the passcodes, which live in the vault", () => {
    const db = createTestDb();
    setSetting(db, "run.accounts", { "p:1": "tester@example.com" });
    setSetting(db, "run.folders", [{ id: 1, path: "/Users/me/app" }]);

    const keys = exportConfig(db).settings.map((setting) => setting.key);
    assert.ok(!keys.includes("run.accounts"));
    assert.ok(keys.includes("run.folders"));
    assert.equal(isSecretLikeSettingKey("run.accounts"), true);
  });

  it("keeps document shortcuts in the local settings backup", () => {
    const db = createTestDb();
    setSetting(db, "documents.shortcuts", [
      { id: 1, label: "Spec", path: "/Users/me/spec.md", opener: "cursor", createdAt: 1, updatedAt: 1 }
    ]);

    const backup = exportConfig(db);
    assert.deepEqual(backup.settings.find((setting) => setting.key === "documents.shortcuts")?.value, [
      { id: 1, label: "Spec", path: "/Users/me/spec.md", opener: "cursor", createdAt: 1, updatedAt: 1 }
    ]);

    const target = createTestDb();
    importConfig(target, JSON.parse(JSON.stringify(backup)));
    assert.deepEqual(exportConfig(target).settings.find((setting) => setting.key === "documents.shortcuts")?.value, [
      { id: 1, label: "Spec", path: "/Users/me/spec.md", opener: "cursor", createdAt: 1, updatedAt: 1 }
    ]);
  });
});

describe("importConfig", () => {
  it("restores config into a fresh database (round trip)", () => {
    const source = createTestDb();
    populate(source);
    const backup = exportConfig(source);

    const target = createTestDb();
    const result = importConfig(target, JSON.parse(JSON.stringify(backup)));

    assert.deepEqual(result, { settings: 1, projects: 1, branchRules: 2, rules: 1, terminalMappings: 1 });
    const again = exportConfig(target);
    assert.deepEqual({ ...again, exportedAt: 0 }, { ...backup, exportedAt: 0, rules: backup.rules.map((r) => ({ ...r, skipConfirm: false })) });
  });

  it("resets 'skip confirmation' so an imported file cannot silently disable the gate", () => {
    const source = createTestDb();
    populate(source);
    assert.equal(exportConfig(source).rules[0]?.skipConfirm, true);

    const target = createTestDb();
    importConfig(target, JSON.parse(JSON.stringify(exportConfig(source))));

    assert.equal(exportConfig(target).rules[0]?.skipConfirm, false);
  });

  it("rejects unknown action types", () => {
    const source = createTestDb();
    populate(source);
    const backup = JSON.parse(JSON.stringify(exportConfig(source)));
    backup.rules[0].actions.push({ type: "rm_rf_everything" });

    const target = createTestDb();
    assert.throws(() => importConfig(target, backup), BackupValidationError);
    assert.equal(Number(target.prepare("SELECT COUNT(*) AS n FROM rules").get()?.n), 0);
  });

  it("rejects unknown top-level fields such as an embedded key store", () => {
    const backup = { ...JSON.parse(JSON.stringify(exportConfig(createTestDb()))), apiKeys: [{ name: "x" }] };
    assert.throws(() => parseBackup(backup), BackupValidationError);
  });

  it("rejects newer schema versions, secret-like settings and bad project names", () => {
    const base = JSON.parse(JSON.stringify(exportConfig(createTestDb())));
    assert.throws(() => parseBackup({ ...base, schemaVersion: 99 }), BackupValidationError);
    assert.throws(
      () => parseBackup({ ...base, settings: [{ key: "ai.apiKey", value: "sk-xyz" }] }),
      BackupValidationError
    );
    assert.throws(
      () =>
        parseBackup({
          ...base,
          projects: [
            { owner: "../etc", repo: "x", name: "x", localPath: null, defaultBranch: null, branchFilter: ["*"], pollIntervalSec: 30, mode: "poll", aiEnabled: false, enabled: true }
          ]
        }),
      BackupValidationError
    );
  });

  it("keeps event history when projects are re-imported", () => {
    const db = createTestDb();
    populate(db);
    const projectId = Number(db.prepare("SELECT id FROM projects").get()?.id);
    insertEvent(db, makeEvent(projectId));

    importConfig(db, JSON.parse(JSON.stringify(exportConfig(db))));

    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM push_events").get()?.n), 1);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM projects").get()?.n), 1);
  });
});

describe("writeBackup", () => {
  it("rotates to the newest 10 files", () => {
    const db = createTestDb();
    const dir = tempDir();

    for (let i = 0; i < 13; i += 1) {
      setSetting(db, "retention.days", i);
      const result = writeBackup(dir, exportConfig(db, 1_700_000_000_000 + i * 1000), { now: 1_700_000_000_000 + i * 1000 });
      assert.equal(result.written, true);
    }

    const files = listBackups(dir);
    assert.equal(files.length, BACKUP_KEEP);
    assert.ok(files[0] && files[0] > (files[files.length - 1] as string), "sorted newest first");
    assert.equal(readdirSync(dir).filter((name) => name.endsWith(".tmp")).length, 0);
  });

  it("skips writing when nothing changed since the latest backup", () => {
    const db = createTestDb();
    populate(db);
    const dir = tempDir();

    assert.equal(writeBackup(dir, exportConfig(db, 1000), { now: 1000 }).written, true);
    assert.equal(writeBackup(dir, exportConfig(db, 2000), { now: 2000 }).written, false);
    assert.equal(listBackups(dir).length, 1);

    setSetting(db, "retention.days", 99);
    assert.equal(writeBackup(dir, exportConfig(db, 3000), { now: 3000 }).written, true);
    assert.equal(listBackups(dir).length, 2);
  });

  it("writes owner-only files into an owner-only directory", () => {
    const db = createTestDb();
    const dir = join(tempDir(), "backups");
    const result = writeBackup(dir, exportConfig(db), { now: 5000 });

    assert.ok(result.path);
    assert.equal(statSync(result.path).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });
});

describe("readBackupFile", () => {
  it("rejects oversized files before parsing", () => {
    const dir = tempDir();
    const path = join(dir, "big.json");
    writeFileSync(path, " ".repeat(MAX_BACKUP_BYTES + 1));
    assert.throws(() => readBackupFile(path), BackupValidationError);
  });

  it("reads a written backup back", () => {
    const db = createTestDb();
    populate(db);
    const dir = tempDir();
    const result = writeBackup(dir, exportConfig(db), { now: 7000 });
    assert.ok(result.path);
    const parsed = parseBackup(readBackupFile(result.path));
    assert.equal(parsed.rules.length, 1);
    assert.equal(JSON.parse(readFileSync(result.path, "utf8")).schemaVersion, 1);
  });
});
