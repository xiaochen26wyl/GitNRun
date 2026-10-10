import type { Db } from "@main/db/database";
import { redactDeep, redactSecrets } from "@main/log-redaction";

export type LogCategory = "push" | "rule" | "command" | "ai" | "system";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  category: LogCategory;
  level: LogLevel;
  message: string;
  detail?: unknown;
}

export const MAX_LOG_MESSAGE = 2_000;
export const MAX_LOG_DETAIL = 20_000;

const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…[truncated]` : text;

const serializeDetail = (detail: unknown): string | null => {
  if (detail === undefined) {
    return null;
  }
  const json = JSON.stringify(redactDeep(detail)) ?? "null";
  // 截斷 JSON 會讓它無法解析，改存一個帶預覽的有效 JSON 物件。
  return json.length > MAX_LOG_DETAIL
    ? JSON.stringify({ truncated: true, preview: json.slice(0, MAX_LOG_DETAIL) })
    : json;
};

/** 寫入 logs 表。訊息與細節在落地前一律脫敏、限長。 */
export const appendLog = (db: Db, entry: LogEntry, now: number = Date.now()): void => {
  db.prepare("INSERT INTO logs (ts, category, level, message, detail_json) VALUES (?, ?, ?, ?, ?)").run(
    now,
    entry.category,
    entry.level,
    truncate(redactSecrets(entry.message), MAX_LOG_MESSAGE),
    serializeDetail(entry.detail)
  );
};

const CONSOLE_METHOD: Record<LogLevel, "debug" | "info" | "warn" | "error"> = {
  debug: "debug",
  info: "info",
  warn: "warn",
  error: "error"
};

export interface Logger {
  log(entry: LogEntry): void;
}

/** 同時寫入資料庫與 console（console 只印脫敏後的訊息，不印 detail）。 */
export const createLogger = (getDb: () => Db | null): Logger => ({
  log(entry) {
    const message = truncate(redactSecrets(entry.message), MAX_LOG_MESSAGE);
    console[CONSOLE_METHOD[entry.level]](`[gitnrun:${entry.category}] ${message}`);
    try {
      const db = getDb();
      if (db) {
        appendLog(db, entry);
      }
    } catch {
      // 日誌寫入失敗不應影響主流程。
    }
  }
});
