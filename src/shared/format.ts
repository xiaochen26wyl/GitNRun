/** 渲染層的顯示輔助（純函式，不依賴 DOM）。 */

const dateTime = new Intl.DateTimeFormat("zh-TW", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

export const formatDateTime = (timestamp: number): string => dateTime.format(new Date(timestamp));

export const formatTimeOfDay = (timestamp: number): string =>
  new Intl.DateTimeFormat("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(timestamp));

export const formatRelative = (timestamp: number, now: number = Date.now()): string => {
  const seconds = Math.round((now - timestamp) / 1000);
  if (seconds < 10) return "剛剛";
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分鐘前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小時前`;
  return `${Math.floor(hours / 24)} 天前`;
};

export const shortSha = (sha: string | null): string => (sha ? sha.slice(0, 7) : "—");

export interface TimeRange {
  id: string;
  label: string;
  /** null 代表不限。 */
  ms: number | null;
}

const HOUR = 3_600_000;

export const TIME_RANGES: readonly TimeRange[] = [
  { id: "1h", label: "1 小時內", ms: HOUR },
  { id: "24h", label: "24 小時內", ms: 24 * HOUR },
  { id: "7d", label: "7 天內", ms: 7 * 24 * HOUR },
  { id: "30d", label: "30 天內", ms: 30 * 24 * HOUR },
  { id: "all", label: "全部", ms: null }
];

export const rangeToFromMs = (rangeId: string, now: number = Date.now()): number | undefined => {
  const range = TIME_RANGES.find((candidate) => candidate.id === rangeId);
  return range?.ms == null ? undefined : now - range.ms;
};

/** Electron 會把主程序丟出的錯誤包上 "Error invoking remote method ..." 前綴，顯示前拿掉。 */
export const errorMessage = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const cleaned = raw.replace(/^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?/, "").trim();
  return cleaned || "操作失敗";
};

export const EVENT_TYPE_LABEL = {
  push: "推送",
  create: "新分支",
  delete: "刪除分支"
} as const;

export const FILE_STATUS_LABEL = {
  added: "新增",
  modified: "修改",
  removed: "刪除",
  renamed: "更名"
} as const;
