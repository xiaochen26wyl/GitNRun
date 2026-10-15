import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createAppSettingsHandlers } from "@main/app-settings";
import { addProject } from "@main/db/projects-repo";
import { listRules, createRule } from "@main/db/rules-repo";
import { saveMapping, listMappings } from "@main/db/mappings-repo";
import { purgeExpired } from "@main/db/retention";
import { getSetting } from "@main/db/settings-repo";
import { UserFacingError } from "@main/errors";
import { createTestDb } from "./helpers/db";

const root = mkdtempSync(join(tmpdir(), "gitnrun-settings-"));
after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;

const setup = () => {
  const db = createTestDb();
  const backupDir = join(root, `b${(counter += 1)}`);
  const calls = { changed: 0, restored: 0 };
  let clock = 1_700_000_000_000;
  const handlers = createAppSettingsHandlers({
    db, backupDir, now: () => (clock += 1000),
    onConfigChanged: () => void (calls.changed += 1),
    onRestored: () => void (calls.restored += 1)
  });
  return { db, handlers, calls, backupDir };
};

describe("general settings", () => {
  it("start with sensible defaults", () => {
    assert.deepEqual(setup().handlers.get(), { retentionDays: 30 });
  });

  it("save and read back each setting, scheduling a backup", () => {
    const t = setup();
    const saved = t.handlers.save({ retentionDays: 90 });
    assert.deepEqual(saved, { retentionDays: 90 });
    assert.equal(t.calls.changed, 1);
  });

  it("reports data usage for the three retained categories", () => {
    const usage = setup().handlers.dataUsage();
    assert.deepEqual(Object.keys(usage).sort(), ["aiCalls", "databaseBytes", "events", "freeBytes", "logs"]);
    assert.equal(usage.logs.count, 0);
  });

  it("'keep forever' is stored as null and the retention job then deletes nothing", () => {
    const t = setup();
    t.handlers.save({ retentionDays: null });
    assert.equal(t.handlers.get().retentionDays, null);
    assert.equal(getSetting(t.db, "retention.days", 30), null);
    assert.deepEqual(purgeExpired(t.db, { retentionDays: t.handlers.get().retentionDays, now: 9e15 }), { events: 0, logs: 0, aiCalls: 0 });
  });

  it("rejects anything invalid and applies none of a bad batch", () => {
    const t = setup();
    for (const bad of [
      { retentionDays: 0 }, { retentionDays: 4000 }, { retentionDays: 1.5 }, { retentionDays: "30" as never }
    ]) {
      assert.throws(() => t.handlers.save(bad), UserFacingError, JSON.stringify(bad));
    }
    assert.equal(t.handlers.get().retentionDays, 30, "a rejected request was not applied");
    assert.equal(t.calls.changed, 0);
  });
});

describe("backups", () => {
  const populate = (t: ReturnType<typeof setup>) => {
    addProject(t.db, { owner: "acme", repo: "api", name: "acme/api", localPath: "/p", branchFilter: ["*"], pollIntervalSec: 30, mode: "poll", enabled: true, aiEnabled: false });
    createRule(t.db, { name: "r", enabled: true, priority: 1, matchMode: "all", conditions: [], actions: [{ type: "notify_system" }], cooldownSec: 0, skipConfirm: true });
    saveMapping(t.db, { pathPattern: "/Users/me/api", command: "pnpm dev", recursive: false, terminalApp: "default" });
  };

  it("back up on demand, skip when nothing changed, and list newest first with size and time", () => {
    const t = setup();
    populate(t);
    assert.deepEqual(t.handlers.backupNow(), { written: true });
    assert.deepEqual(t.handlers.backupNow(), { written: false }, "identical content is not written twice");

    t.handlers.save({ retentionDays: 14 });
    assert.deepEqual(t.handlers.backupNow(), { written: true });

    const list = t.handlers.listBackups();
    assert.equal(list.length, 2);
    assert.ok(list[0] && list[1] && list[0].name > list[1].name);
    assert.ok(list.every((entry) => entry.bytes > 0 && entry.createdAt > 0));
  });

  it("an empty backup folder lists nothing", () => {
    assert.deepEqual(setup().handlers.listBackups(), []);
  });

  it("a backup made on one machine restores into a brand-new database — rules come back with the confirmation gate on", () => {
    const source = setup();
    populate(source);
    source.handlers.backupNow();
    const [backup] = source.handlers.listBackups();
    assert.ok(backup);

    // 全新的資料庫與備份資料夾；把來源的備份檔放進去（等同換機後把備份檔複製過來）。
    const target = setup();
    mkdirSync(target.backupDir, { recursive: true });
    copyFileSync(join(source.backupDir, backup.name), join(target.backupDir, backup.name));
    assert.equal(listRules(target.db).length, 0);

    const summary = target.handlers.restore(backup.name);

    assert.deepEqual(summary, { settings: 0, projects: 1, branchRules: 0, rules: 1, terminalMappings: 1 });
    assert.equal(listRules(target.db)[0]?.skipConfirm, false, "the source rule had skip-confirm on; the restored one does not");
    assert.equal(listMappings(target.db)[0]?.command, "pnpm dev");
    assert.equal(target.calls.restored, 1);
  });

  it("restore works from the app's own backup folder", () => {
    const t = setup();
    populate(t);
    t.handlers.backupNow();
    const [backup] = t.handlers.listBackups();
    assert.ok(backup);

    // 弄壞現有設定，再還原。
    t.db.exec("DELETE FROM rules; DELETE FROM terminal_mappings");
    assert.equal(listRules(t.db).length, 0);

    const summary = t.handlers.restore(backup.name);

    assert.deepEqual(summary, { settings: 0, projects: 1, branchRules: 0, rules: 1, terminalMappings: 1 });
    assert.equal(listRules(t.db)[0]?.skipConfirm, false, "a restored rule asks for confirmation again");
    assert.equal(listMappings(t.db).length, 1);
    assert.equal(t.calls.restored, 1);
  });

  it("only restores files that are in the backup folder and look like backups", () => {
    const t = setup();
    populate(t);
    t.handlers.backupNow();
    for (const bad of ["../../etc/passwd", "/etc/passwd", "config-nope.json", "config-20260101-000000-000.json", "", "notes.txt"]) {
      assert.throws(() => t.handlers.restore(bad), (error) => error instanceof UserFacingError && error.message.includes("找不到"), bad);
    }
    assert.equal(t.calls.restored, 0);
  });

  it("a damaged backup is reported without touching the current settings", () => {
    const t = setup();
    populate(t);
    t.handlers.backupNow();
    const [backup] = t.handlers.listBackups();
    writeFileSync(join(t.backupDir, backup!.name), JSON.stringify({ schemaVersion: 1, exportedAt: 1, apiKeys: [{ name: "x" }] }));

    assert.throws(() => t.handlers.restore(backup!.name), (error) => error instanceof UserFacingError && error.message.includes("無法還原"));
    assert.equal(listRules(t.db).length, 1);
    assert.equal(t.calls.restored, 0);
  });
});

import { RETENTION_CHOICES } from "@shared/app-settings";
import { asAppSettingsArgs, asBackupNameArgs, isKnownChannel } from "@main/ipc-validation";
import { IPC } from "@shared/ipc";

describe("settings IPC arguments", () => {
  it("channels are declared", () => {
    for (const channel of [IPC.appSettingsGet, IPC.appSettingsSave, IPC.backupsList, IPC.backupsNow, IPC.backupsRestore]) {
      assert.equal(isKnownChannel(channel), true, channel);
    }
  });

  it("only the four known settings can be sent", () => {
    assert.deepEqual(asAppSettingsArgs([{ retentionDays: 30 }]), [{ retentionDays: 30 }]);
    assert.deepEqual(asAppSettingsArgs([{}]), [{}]);
    for (const bad of [[], [null], ["x"], [[]], [{ retentionDays: 30, evil: true }], [{ unknownKey: 1 }], [{}, {}]]) {
      assert.equal(asAppSettingsArgs(bad), null, JSON.stringify(bad));
    }
  });

  it("backup names must look like the files this program writes", () => {
    assert.deepEqual(asBackupNameArgs(["config-20261009-103045-123.json"]), ["config-20261009-103045-123.json"]);
    for (const bad of [[], [""], ["../config-20261009-103045-123.json"], ["/etc/passwd"], ["config-1.json"], ["config-20261009-103045-123.json.bak"], [5], ["x".repeat(101)]]) {
      assert.equal(asBackupNameArgs(bad), null, JSON.stringify(bad));
    }
  });

  it("the retention choices include 'forever' and the 30-day default", () => {
    assert.ok(RETENTION_CHOICES.some((choice) => choice.days === null));
    assert.ok(RETENTION_CHOICES.some((choice) => choice.days === 30));
  });
});
