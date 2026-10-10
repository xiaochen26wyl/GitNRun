import type { Db } from "@main/db/database";

/** 設定以 key／JSON 值存放；值不得放密鑰（密鑰只走 vault）。 */

export const getSetting = <T>(db: Db, key: string, fallback: T): T => {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  if (!row || typeof row.value !== "string") {
    return fallback;
  }
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
};

export const setSetting = (db: Db, key: string, value: unknown, now: number = Date.now()): void => {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, JSON.stringify(value), now);
};

export const listSettings = (db: Db): Array<{ key: string; value: unknown }> =>
  db
    .prepare("SELECT key, value FROM settings ORDER BY key")
    .all()
    .flatMap((row) => {
      try {
        return [{ key: String(row.key), value: JSON.parse(String(row.value)) as unknown }];
      } catch {
        return [];
      }
    });

export const SETTING_KEYS = {
  retentionDays: "retention.days"
} as const;

export const DEFAULT_RETENTION_DAYS = 30;
