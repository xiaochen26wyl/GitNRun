/**
 * 任何要寫進日誌、console、指令輸出、AI 請求記錄的內容，一律先經過這裡。
 *
 * 規則：src/main 裡不得把原始 Error 物件或請求設定交給 console.*，
 * child_process 與 HTTP client 的錯誤物件會把整條指令／標頭帶進去。
 */

export const REDACTION_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/github_pat_[A-Za-z0-9_]{20,}/g, "github_pat_[redacted]"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, "gh_[redacted]"],
  // Anthropic 要排在泛用的 sk- 之前。
  [/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-[redacted]"],
  [/sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, "sk-[redacted]"],
  [/xox[abposr]-[A-Za-z0-9-]{10,}/g, "xox-[redacted]"],
  [/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g, "https://hooks.slack.com/services/[redacted]"],
  // Bearer／Basic 要排在 Authorization 標頭規則之前，否則只會吃掉 scheme 而留下 token。
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [/Basic\s+[A-Za-z0-9+/=]{8,}/g, "Basic [redacted]"],
  [/(authorization["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, "$1[redacted]"],
  [/(x-api-key["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, "$1[redacted]"],
  [
    /("(?:access_?token|refresh_?token|api_?key|client_?secret|secret|password|token)"\s*:\s*")[^"]*(")/gi,
    "$1[redacted]$2"
  ],
  [/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_?KEY)[A-Z0-9_]*)=([^\s'"]+)/g, "$1=[redacted]"],
  // https://user:password@host
  [/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/g, "$1[redacted]@"]
];

export const redactSecrets = (text: string): string =>
  REDACTION_PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);

/** 任何值轉成可安全寫入日誌的字串；Error 只取 name 與 message。 */
export const redact = (value: unknown): string => {
  if (value instanceof Error) {
    return redactSecrets(`${value.name}: ${value.message}`);
  }
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  try {
    return redactSecrets(String(value));
  } catch {
    return "[unprintable]";
  }
};

const SECRET_KEY = /token|secret|password|passwd|authorization|api[_-]?key|ciphertext|credential/i;
const MAX_DEPTH = 8;

/** 遞迴脫敏：字串過 pattern，鍵名像密鑰的整個值直接遮蔽。 */
export const redactDeep = (value: unknown, depth = 0): unknown => {
  if (depth > MAX_DEPTH) {
    return "[depth-limit]";
  }
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (value instanceof Error) {
    return { name: value.name, message: redactSecrets(value.message) };
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEY.test(key) ? "[redacted]" : redactDeep(item, depth + 1)
      ])
    );
  }
  return value;
};

const MIN_KNOWN_VALUE_LENGTH = 6;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 以「已知密鑰值」做精確比對的脫敏器。Webhook secret、規則的敏感環境變數這類
 * 沒有固定前綴的值，pattern 抓不到，執行指令時把注入的值交給這個函式。
 * 太短的值不處理，避免把一般文字誤遮蔽。
 */
export const createValueRedactor = (values: readonly string[]): ((text: string) => string) => {
  const usable = [...new Set(values.filter((value) => value.length >= MIN_KNOWN_VALUE_LENGTH))].sort(
    (a, b) => b.length - a.length
  );
  if (usable.length === 0) {
    return (text) => text;
  }
  const pattern = new RegExp(usable.map(escapeRegExp).join("|"), "g");
  return (text) => text.replace(pattern, "[redacted]");
};
