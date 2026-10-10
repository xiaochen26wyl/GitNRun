import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Db = DatabaseSync;

export const MEMORY_DB = ":memory:";

/** 目錄只給擁有者存取（0700）；已存在也會把權限收斂回 0700。 */
export const ensureSecureDirectory = (dir: string): void => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
};

/**
 * 開啟本機資料庫：WAL、busy_timeout、外鍵；檔案權限 0600。
 * 先以 0600 建立空檔再讓 SQLite 開啟（SQLite 的 -wal／-shm 沿用主檔權限）。
 */
export const openDatabase = (path: string): Db => {
  if (path !== MEMORY_DB) {
    ensureSecureDirectory(dirname(path));
    writeFileSync(path, "", { flag: "a", mode: 0o600 });
    chmodSync(path, 0o600);
  }

  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  return db;
};

/** 交易包裝（不支援巢狀）；回呼丟出例外時整段回滾。 */
export const inTransaction = <T>(db: Db, fn: () => T): T => {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};
