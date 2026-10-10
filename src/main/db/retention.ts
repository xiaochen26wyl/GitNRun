import type { Db } from "@main/db/database";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;
export const DEFAULT_PURGE_BATCH = 1000;

export interface PurgeOptions {
  /** null 代表永久保留，不清理。 */
  retentionDays: number | null;
  now?: number;
  batchSize?: number;
}

export interface PurgeResult {
  events: number;
  logs: number;
  aiCalls: number;
}

const SELF_EVENT_TTL_MS = 7 * DAY_MS;

/** 把保留天數限制在合理範圍；非有限數字視為預設無效，回傳 null 由呼叫端決定。 */
export const clampRetentionDays = (days: number): number =>
  Math.min(Math.max(Math.floor(days), MIN_RETENTION_DAYS), MAX_RETENTION_DAYS);

const deleteInBatches = (db: Db, table: string, column: string, cutoff: number, batchSize: number): number => {
  // table／column 只來自本檔的固定常數，不接受外部輸入。
  const statement = db.prepare(
    `DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE ${column} < ? ORDER BY ${column} LIMIT ?)`
  );
  let total = 0;
  for (;;) {
    const changes = Number(statement.run(cutoff, batchSize).changes);
    total += changes;
    if (changes < batchSize) {
      return total;
    }
  }
};

/**
 * 清理過期資料：push_events（rule_executions 由外鍵 CASCADE 一併清除）、logs、ai_calls。
 * 每批各自提交，避免一次刪大量資料長時間鎖住資料庫。
 */
export const purgeExpired = (db: Db, options: PurgeOptions): PurgeResult => {
  const now = options.now ?? Date.now();
  // 規則自己造成的 SHA 只需要撐過幾輪輪詢，固定一週後清掉，不受保留天數設定影響。
  db.prepare("DELETE FROM rule_self_events WHERE created_at < ?").run(now - SELF_EVENT_TTL_MS);
  // 送達 ID 只需要撐過 GitHub 的重試期間。
  db.prepare("DELETE FROM webhook_deliveries WHERE received_at < ?").run(now - SELF_EVENT_TTL_MS);
  if (options.retentionDays === null) {
    return { events: 0, logs: 0, aiCalls: 0 };
  }
  const batchSize = options.batchSize ?? DEFAULT_PURGE_BATCH;
  const cutoff = now - clampRetentionDays(options.retentionDays) * DAY_MS;

  return {
    events: deleteInBatches(db, "push_events", "occurred_at", cutoff, batchSize),
    logs: deleteInBatches(db, "logs", "ts", cutoff, batchSize),
    aiCalls: deleteInBatches(db, "ai_calls", "ts", cutoff, batchSize)
  };
};
