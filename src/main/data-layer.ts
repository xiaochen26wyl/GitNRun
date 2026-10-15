import { statSync } from "node:fs";
import { join } from "node:path";
import { isBackupOverdue, nextBackupAt } from "@main/backup-schedule";
import { exportConfig, listBackups, writeBackup } from "@main/db/backup";
import { openDatabase, type Db } from "@main/db/database";
import { migrate } from "@main/db/migrations";
import { DAY_MS, purgeExpired } from "@main/db/retention";
import { DEFAULT_RETENTION_DAYS, SETTING_KEYS, getSetting } from "@main/db/settings-repo";
import { native } from "@main/native/bridge";

/**
 * 資料層的生命週期：開庫、遷移、每天 22:00 的備份（錯過則啟動後補）與每日清理。
 * 所有資料都在 userData/data 之下，不寫到任何雲端。
 */

const STARTUP_BACKUP_DELAY_MS = 5_000;
const FIRST_PURGE_DELAY_MS = 30_000;

let database: Db | null = null;
let backupDir = "";
let dailyBackupTimer: NodeJS.Timeout | null = null;
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

/** 最新一份備份的時間；沒有備份或讀不到時回 null。 */
const latestBackupAt = (): number | null => {
  const newest = listBackups(backupDir)[0];
  if (!newest) {
    return null;
  }
  try {
    return statSync(join(backupDir, newest)).mtimeMs;
  } catch {
    return null;
  }
};

/** 排到下一個 22:00；觸發後依當下時間重排，不用固定 24 小時間隔，避免睡眠與夏令時間造成偏移。 */
const scheduleDailyBackup = (): void => {
  const delay = Math.max(1_000, nextBackupAt(Date.now()) - Date.now());
  dailyBackupTimer = setTimeout(() => {
    runBackup();
    scheduleDailyBackup();
  }, delay);
  dailyBackupTimer.unref();
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
  const dataDir = join(native().dataDir(), "data");
  backupDir = join(dataDir, "backups");

  database = openDatabase(join(dataDir, "gitnrun.db"));
  migrate(database);

  // 啟動流程保持輕量：備份與清理延後到視窗顯示之後。
  // 錯過昨晚 22:00（睡眠、關機）時補一次；內容沒變時 writeBackup 不會多寫檔。
  unrefTimeout(() => {
    if (isBackupOverdue(Date.now(), latestBackupAt())) {
      runBackup();
    }
  }, STARTUP_BACKUP_DELAY_MS);
  scheduleDailyBackup();
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
  if (dailyBackupTimer) {
    clearTimeout(dailyBackupTimer);
    dailyBackupTimer = null;
  }
  database?.close();
  database = null;
};
