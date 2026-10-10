/** 日誌記錄的共用型別（日誌頁用）。 */

export const LOG_CATEGORIES = ["push", "rule", "command", "ai", "system"] as const;
export type LogCategoryName = (typeof LOG_CATEGORIES)[number];

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevelName = (typeof LOG_LEVELS)[number];

export interface LogRecord {
  id: number;
  ts: number;
  category: string;
  level: string;
  message: string;
  detail: unknown;
}

export interface LogQuery {
  category?: LogCategoryName;
  level?: LogLevelName;
  search?: string;
  fromMs?: number;
  toMs?: number;
  limit?: number;
  offset?: number;
}

export interface LogPage {
  logs: LogRecord[];
  hasMore: boolean;
}

export const LOG_QUERY_DEFAULT_LIMIT = 100;
export const LOG_QUERY_MAX_LIMIT = 500;
