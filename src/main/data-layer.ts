import { join } from "node:path";
import { app } from "electron";
import { exportConfig, writeBackup } from "@main/db/backup";
import { openDatabase, type Db } from "@main/db/database";
import { migrate } from "@main/db/migrations";
import { DAY_MS, purgeExpired } from "@main/db/retention";
import { DEFAULT_RETENTION_DAYS, SETTING_KEYS, getSetting } from "@main/db/settings-repo";

/**
 * 資料層的生命週期：開庫、遷移、啟動後的備份與每日清理。
 * 所有資料都在 userData/data 之下，不寫到任何雲端。
 */

const BACKUP_DEBOUNCE_MS = 5_000;
const STARTUP_BACKUP_DELAY_MS = 5_000;
const FIRST_PURGE_DELAY_MS = 30_000;

let database: Db | null = null;
let backupDir = "";
let backupTimer: NodeJS.Timeout | null = null;
const timers: NodeJS.Timeout[] = [];

export const getBackupDir = (): string => backupDir;

export const getDb = (): Db => {
  if (!database) {
    throw new Error("data layer is not initialised");
  }
  return database;
};

const runBackup = (): void => {
  try {
    writeBackup(backupDir, exportConfig(getDb()));
  } catch (error) {
    console.warn(`[gitnrun] config backup failed: ${error instanceof Error ? error.name : "error"}`);
  }
};

/** 設定、規則、映射、分支範本變更後呼叫；短時間內多次呼叫會合併成一次備份。 */
export const backupSoon = (): void => {
  if (!database) {
    return;
  }
  if (backupTimer) {
    clearTimeout(backupTimer);
  }
  backupTimer = setTimeout(() => {
    backupTimer = null;
    runBackup();
  }, BACKUP_DEBOUNCE_MS);
  backupTimer.unref();
};

const runPurge = (): void => {
  try {
    const db = getDb();
    const days = getSetting<number | null>(db, SETTING_KEYS.retentionDays, DEFAULT_RETENTION_DAYS);
    purgeExpired(db, { retentionDays: days });
  } catch (error) {
    console.warn(`[gitnrun] retention purge failed: ${error instanceof Error ? error.name : "error"}`);
  }
};

const unrefTimeout = (fn: () => void, ms: number): void => {
  const timer = setTimeout(fn, ms);
  timer.unref();
  timers.push(timer);
};

export const initDataLayer = (): Db => {
  const dataDir = join(app.getPath("userData"), "data");
  backupDir = join(dataDir, "backups");

  database = openDatabase(join(dataDir, "gitnrun.db"));
  migrate(database);

  // 啟動流程保持輕量：備份與清理延後到視窗顯示之後。
  unrefTimeout(runBackup, STARTUP_BACKUP_DELAY_MS);
  unrefTimeout(() => {
    runPurge();
    const daily = setInterval(runPurge, DAY_MS);
    daily.unref();
    timers.push(daily);
  }, FIRST_PURGE_DELAY_MS);

  return database;
};

export const closeDataLayer = (): void => {
  for (const timer of timers) {
    clearTimeout(timer);
    clearInterval(timer);
  }
  timers.length = 0;
  if (backupTimer) {
    clearTimeout(backupTimer);
    backupTimer = null;
  }
  database?.close();
  database = null;
};
