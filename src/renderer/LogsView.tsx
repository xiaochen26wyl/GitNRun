import { useCallback, useEffect, useState } from "react";
import {
  LOG_CATEGORIES,
  LOG_LEVELS,
  type LogCategoryName,
  type LogLevelName,
  type LogQuery,
  type LogRecord
} from "@shared/logs";
import { TIME_RANGES, errorMessage, formatDateTime, rangeToFromMs } from "@shared/format";
import { useDebounced, useMonitorChanged } from "./hooks";
import { LiveOutput } from "./LiveOutput";

const PAGE_SIZE = 100;

const CATEGORY_LABEL: Record<LogCategoryName, string> = {
  push: "推送",
  rule: "規則執行",
  command: "指令執行",
  ai: "AI 調用",
  system: "系統"
};

const LEVEL_LABEL: Record<LogLevelName, string> = {
  debug: "除錯",
  info: "資訊",
  warn: "警告",
  error: "錯誤"
};

/**
 * 日誌頁：四類記錄（推送、規則執行、指令執行、AI 調用）共用同一組篩選與搜尋，
 * 之後各功能只需要寫入對應類別，不必再做自己的畫面。
 */
export const LogsView = () => {
  const [category, setCategory] = useState<LogCategoryName | "">("");
  const [level, setLevel] = useState<LogLevelName | "">("");
  const [rangeId, setRangeId] = useState("7d");
  const [search, setSearch] = useState("");
  const [logs, setLogs] = useState<LogRecord[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");
  const debouncedSearch = useDebounced(search.trim(), 250);

  const load = useCallback(
    async (append: boolean, currentCount: number) => {
      setError("");
      try {
        const query: LogQuery = { limit: PAGE_SIZE, offset: append ? currentCount : 0 };
        if (category) query.category = category;
        if (level) query.level = level;
        if (debouncedSearch) query.search = debouncedSearch;
        const fromMs = rangeToFromMs(rangeId);
        if (fromMs !== undefined) query.fromMs = fromMs;

        const page = await window.gitNRun.queryLogs(query);
        setLogs((previous) => (append ? [...previous, ...page.logs] : page.logs));
        setHasMore(page.hasMore);
      } catch (loadError) {
        setError(errorMessage(loadError));
      }
    },
    [category, level, rangeId, debouncedSearch]
  );

  useEffect(() => {
    void load(false, 0);
  }, [load]);

  useMonitorChanged(() => void load(false, 0));

  return (
    <section>
      <LiveOutput />
      <div className="filters">
        <select aria-label="類別" value={category} onChange={(event) => setCategory(event.target.value as LogCategoryName | "")}>
          <option value="">全部類別</option>
          {LOG_CATEGORIES.map((name) => (
            <option key={name} value={name}>
              {CATEGORY_LABEL[name]}
            </option>
          ))}
        </select>
        <select aria-label="等級" value={level} onChange={(event) => setLevel(event.target.value as LogLevelName | "")}>
          <option value="">全部等級</option>
          {LOG_LEVELS.map((name) => (
            <option key={name} value={name}>
              {LEVEL_LABEL[name]}
            </option>
          ))}
        </select>
        <select aria-label="時間範圍" value={rangeId} onChange={(event) => setRangeId(event.target.value)}>
          {TIME_RANGES.map((range) => (
            <option key={range.id} value={range.id}>
              {range.label}
            </option>
          ))}
        </select>
        <input aria-label="搜尋" placeholder="搜尋日誌內容" value={search} onChange={(event) => setSearch(event.target.value)} />
      </div>

      {error ? <p className="warn">{error}</p> : null}
      {logs.length === 0 ? <p className="muted empty">沒有符合條件的日誌。</p> : null}

      <ul className="log-list">
        {logs.map((log) => (
          <li key={log.id} className={`log log-${log.level}`}>
            <span className="muted">{formatDateTime(log.ts)}</span>
            <span className="badge">{CATEGORY_LABEL[log.category as LogCategoryName] ?? log.category}</span>
            <span>{log.message}</span>
          </li>
        ))}
      </ul>

      {hasMore ? (
        <button type="button" onClick={() => void load(true, logs.length)}>
          載入更多
        </button>
      ) : null}
    </section>
  );
};
