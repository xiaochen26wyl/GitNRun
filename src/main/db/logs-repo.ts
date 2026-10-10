import type { SQLInputValue } from "node:sqlite";
import {
  LOG_QUERY_DEFAULT_LIMIT,
  LOG_QUERY_MAX_LIMIT,
  type LogPage,
  type LogQuery,
  type LogRecord
} from "@shared/logs";
import type { Db } from "@main/db/database";

const parseDetail = (value: unknown): unknown => {
  if (typeof value !== "string") {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

const rowToLog = (row: Record<string, unknown>): LogRecord => ({
  id: Number(row.id),
  ts: Number(row.ts),
  category: String(row.category),
  level: String(row.level),
  message: String(row.message),
  detail: parseDetail(row.detail_json)
});

const likePattern = (input: string): string => `%${input.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

/** 日誌頁共用的篩選＋搜尋＋分頁（所有類別共用同一個查詢）。 */
export const queryLogs = (db: Db, query: LogQuery = {}): LogPage => {
  const where: string[] = [];
  const params: SQLInputValue[] = [];

  if (query.category) {
    where.push("category = ?");
    params.push(query.category);
  }
  if (query.level) {
    where.push("level = ?");
    params.push(query.level);
  }
  if (query.fromMs !== undefined) {
    where.push("ts >= ?");
    params.push(query.fromMs);
  }
  if (query.toMs !== undefined) {
    where.push("ts <= ?");
    params.push(query.toMs);
  }
  if (query.search) {
    where.push("message LIKE ? ESCAPE '\\'");
    params.push(likePattern(query.search));
  }

  const limit = Math.min(Math.max(query.limit ?? LOG_QUERY_DEFAULT_LIMIT, 1), LOG_QUERY_MAX_LIMIT);
  const offset = Math.max(query.offset ?? 0, 0);
  const rows = db
    .prepare(
      `SELECT * FROM logs ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit + 1, offset);

  return { logs: rows.slice(0, limit).map(rowToLog), hasMore: rows.length > limit };
};
