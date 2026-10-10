import { normalizeFolderPath } from "@shared/launcher";
import { isRunTargetId, normalizeRunAccount } from "@shared/run";
import type { Db } from "@main/db/database";
import { getSetting, setSetting } from "@main/db/settings-repo";

/**
 * 專案啟動頁存在設定表的三份資料：
 * - 使用者拖曳加入的資料夾（只存路徑）
 * - 已確認過的描述檔雜湊（資料夾 → sha256）
 * - dev 通關帳號（目標識別 → 帳號）；密碼不在這裡，在密鑰保險庫。
 * 後兩者的 key（run.trusted、run.accounts）不進備份、也不從備份還原。
 */

export const RUN_KEYS = {
  folders: "run.folders",
  trusted: "run.trusted",
  accounts: "run.accounts"
} as const;

export interface RunFolder {
  id: number;
  path: string;
}

const MAX_FOLDERS = 100;
const MAX_TRUSTED = 200;
const MAX_ACCOUNTS = 300;
const HASH = /^[0-9a-f]{64}$/;

const isFolder = (value: unknown): value is RunFolder =>
  typeof value === "object" &&
  value !== null &&
  Number.isSafeInteger((value as RunFolder).id) &&
  (value as RunFolder).id > 0 &&
  typeof (value as RunFolder).path === "string" &&
  (value as RunFolder).path.startsWith("/");

/** 讀取時重新驗證，資料庫裡被改壞的值當作沒有。 */
export const listRunFolders = (db: Db): RunFolder[] => {
  const stored = getSetting<unknown>(db, RUN_KEYS.folders, []);
  return Array.isArray(stored) ? stored.filter(isFolder).slice(0, MAX_FOLDERS) : [];
};

export const addRunFolder = (db: Db, rawPath: string): RunFolder => {
  const path = normalizeFolderPath(rawPath);
  const folders = listRunFolders(db);
  const existing = folders.find((folder) => folder.path === path);
  if (existing) {
    return existing;
  }
  if (folders.length >= MAX_FOLDERS) {
    throw new Error("加入的資料夾已達上限");
  }
  const added: RunFolder = { id: folders.reduce((max, folder) => Math.max(max, folder.id), 0) + 1, path };
  setSetting(db, RUN_KEYS.folders, [...folders, added]);
  return added;
};

export const removeRunFolder = (db: Db, id: number): boolean => {
  const folders = listRunFolders(db);
  const next = folders.filter((folder) => folder.id !== id);
  if (next.length === folders.length) {
    return false;
  }
  setSetting(db, RUN_KEYS.folders, next);
  return true;
};

const readTrusted = (db: Db): Record<string, string> => {
  const stored = getSetting<unknown>(db, RUN_KEYS.trusted, {});
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    return {};
  }
  return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, string] => typeof entry[1] === "string" && HASH.test(entry[1])));
};

export const isRunTrusted = (db: Db, folder: string, hash: string): boolean => readTrusted(db)[normalizeFolderPath(folder)] === hash;

/** 這個資料夾以前確認過別的內容（現在內容變了）。 */
export const hasTrustedBefore = (db: Db, folder: string): boolean => readTrusted(db)[normalizeFolderPath(folder)] !== undefined;

export const trustRunManifest = (db: Db, folder: string, hash: string): void => {
  const trusted = readTrusted(db);
  trusted[normalizeFolderPath(folder)] = hash;
  const entries = Object.entries(trusted);
  // 超過上限就丟掉最舊的（物件保留插入順序）。
  const kept = entries.length > MAX_TRUSTED ? entries.slice(entries.length - MAX_TRUSTED) : entries;
  setSetting(db, RUN_KEYS.trusted, Object.fromEntries(kept));
};

// ---------------------------------------------------------------------------
// dev 通關帳號
// ---------------------------------------------------------------------------

/** 讀取時重新驗證，資料庫裡被改壞的項目當作沒有。 */
const readAccounts = (db: Db): Record<string, string> => {
  const stored = getSetting<unknown>(db, RUN_KEYS.accounts, {});
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(stored).filter(
      (entry): entry is [string, string] => isRunTargetId(entry[0]) && typeof entry[1] === "string" && entry[1] !== "" && normalizeRunAccount(entry[1]) === entry[1]
    )
  );
};

export const getRunAccount = (db: Db, targetId: string): string => readAccounts(db)[targetId] ?? "";

/** 帳號需已通過 normalizeRunAccount；空字串 = 清除。 */
export const setRunAccount = (db: Db, targetId: string, account: string): void => {
  const accounts = readAccounts(db);
  delete accounts[targetId];
  if (account !== "") {
    accounts[targetId] = account;
  }
  const entries = Object.entries(accounts);
  // 超過上限就丟掉最舊的（物件保留插入順序）。
  const kept = entries.length > MAX_ACCOUNTS ? entries.slice(entries.length - MAX_ACCOUNTS) : entries;
  setSetting(db, RUN_KEYS.accounts, Object.fromEntries(kept));
};
