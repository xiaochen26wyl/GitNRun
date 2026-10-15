import type { DataCategoryUsage, DataUsage } from "@shared/app-settings";
import type { Db } from "@main/db/database";

/**
 * 「資料保留」會清理的三類資料目前占了多少：筆數、佔用空間與最早一筆的時間。
 * 唯讀；佔用空間用 dbstat 加總資料表與其索引的頁數，環境不支援時回 null。
 */

// 事件一併計入規則執行紀錄：清理事件時兩者會一起被刪。
const CATEGORY_TABLES = {
  events: { count: "push_events", oldest: ["push_events", "occurred_at"], sizeTables: ["push_events", "rule_executions"] },
  logs: { count: "logs", oldest: ["logs", "ts"], sizeTables: ["logs"] },
  aiCalls: { count: "ai_calls", oldest: ["ai_calls", "ts"], sizeTables: ["ai_calls"] }
} as const;

const readTableBytes = (db: Db): Map<string, number> | null => {
  try {
    const rows = db
      .prepare(
        `SELECT s.tbl_name AS name, SUM(d.pgsize) AS bytes
         FROM dbstat d JOIN sqlite_schema s ON s.name = d.name
         WHERE s.tbl_name IN ('push_events', 'rule_executions', 'logs', 'ai_calls')
         GROUP BY s.tbl_name`
      )
      .all();
    return new Map(rows.map((row) => [String(row.name), Number(row.bytes)]));
  } catch {
    return null;
  }
};

const pragmaNumber = (db: Db, name: string): number => {
  const row = db.prepare(`PRAGMA ${name}`).get();
  return Number(row ? Object.values(row)[0] : 0);
};

export const readDataUsage = (db: Db): DataUsage => {
  const bytesByTable = readTableBytes(db);
  const category = (key: keyof typeof CATEGORY_TABLES): DataCategoryUsage => {
    const spec = CATEGORY_TABLES[key];
    const [table, column] = spec.oldest;
    // table／column 只來自本檔的固定常數，不接受外部輸入。
    const count = db.prepare(`SELECT COUNT(*) AS n FROM ${spec.count}`).get();
    const oldest = db.prepare(`SELECT MIN(${column}) AS ts FROM ${table}`).get();
    return {
      count: Number(count?.n ?? 0),
      bytes: bytesByTable ? spec.sizeTables.reduce((sum, name) => sum + (bytesByTable.get(name) ?? 0), 0) : null,
      oldestAt: oldest?.ts === null || oldest?.ts === undefined ? null : Number(oldest.ts)
    };
  };

  const pageSize = pragmaNumber(db, "page_size");
  return {
    events: category("events"),
    logs: category("logs"),
    aiCalls: category("aiCalls"),
    databaseBytes: pragmaNumber(db, "page_count") * pageSize,
    freeBytes: pragmaNumber(db, "freelist_count") * pageSize
  };
};
