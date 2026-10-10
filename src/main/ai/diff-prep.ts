import { REDACTION_PATTERNS } from "@main/log-redaction";
import { matchesFilePattern } from "@main/rules/conditions";

/**
 * 送給 AI 之前，先處理差異內容：
 * 1. 排除清單上的檔案，內容完全不送（只留檔名）。
 * 2. 其餘內容裡疑似密鑰的字串遮蔽掉。
 * 3. 超過上限就依檔案邊界截斷。
 * 回傳的資料同時是「這次會送出什麼」的預覽依據。
 */

export interface PreparedDiff {
  text: string;
  includedFiles: string[];
  excludedFiles: string[];
  maskedCount: number;
  bytes: number;
  truncated: boolean;
}

export interface PrepareOptions {
  excludeGlobs: readonly string[];
  maxBytes: number;
}

// 一般 token 格式由 REDACTION_PATTERNS 處理；這裡補上 diff 裡常見、但沒有固定前綴的類型。
const EXTRA_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[PRIVATE KEY REMOVED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[jwt-redacted]"],
  [/((?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)["']?\s*[:=]\s*["'])[^"'\s]{8,}(["'])/gi, "$1[redacted]$2"]
];

const ALL_PATTERNS = [...REDACTION_PATTERNS, ...EXTRA_PATTERNS];

export const maskSecrets = (text: string): { text: string; count: number } => {
  let count = 0;
  let masked = text;
  for (const [pattern, replacement] of ALL_PATTERNS) {
    const matches = masked.match(pattern);
    if (matches) {
      count += matches.length;
      masked = masked.replace(pattern, replacement);
    }
  }
  return { text: masked, count };
};

interface Section {
  path: string | null;
  text: string;
}

const HEADER = /^diff --git /;

/** 從 `diff --git a/x b/x` 取出新路徑；路徑含特殊字元時 git 會加引號。 */
const pathFromHeader = (line: string): string | null => {
  const quoted = /^diff --git "a\/.*" "b\/(.*)"$/.exec(line);
  if (quoted?.[1] !== undefined) return quoted[1];
  const plain = /^diff --git a\/.* b\/(.*)$/.exec(line);
  return plain?.[1] ?? null;
};

export const splitDiff = (diff: string): Section[] => {
  const sections: Section[] = [];
  let current: string[] = [];
  let path: string | null = null;
  const flush = (): void => {
    if (current.length > 0) {
      sections.push({ path, text: current.join("\n") });
    }
    current = [];
  };
  for (const line of diff.split("\n")) {
    if (HEADER.test(line)) {
      flush();
      path = pathFromHeader(line);
    }
    current.push(line);
  }
  flush();
  return sections;
};

const TRUNCATION_NOTE = "\n…[已截斷，其餘內容未送出]";
const MIN_USEFUL_BYTES = 200;

export const prepareDiff = (diff: string, options: PrepareOptions): PreparedDiff => {
  const includedFiles: string[] = [];
  const excludedFiles: string[] = [];
  const parts: string[] = [];
  let remaining = options.maxBytes;
  let maskedCount = 0;
  let truncated = false;

  for (const section of splitDiff(diff)) {
    const { path } = section;
    if (path !== null && options.excludeGlobs.some((pattern) => matchesFilePattern(pattern, path))) {
      excludedFiles.push(path);
      parts.push(`diff --git a/${path} b/${path}\n[內容已排除，不會送出]`);
      continue;
    }

    const masked = maskSecrets(section.text);
    const size = Buffer.byteLength(masked.text);
    if (remaining <= 0 || (size > remaining && remaining < MIN_USEFUL_BYTES)) {
      truncated = true;
      if (path !== null) parts.push(`diff --git a/${path} b/${path}\n[超過大小上限，內容未送出]`);
      continue;
    }

    maskedCount += masked.count;
    if (size <= remaining) {
      parts.push(masked.text);
      remaining -= size;
    } else {
      parts.push(Buffer.from(masked.text).subarray(0, remaining).toString("utf8") + TRUNCATION_NOTE);
      remaining = 0;
      truncated = true;
    }
    if (path !== null) includedFiles.push(path);
  }

  const text = parts.join("\n");
  return { text, includedFiles, excludedFiles, maskedCount, bytes: Buffer.byteLength(text), truncated };
};
