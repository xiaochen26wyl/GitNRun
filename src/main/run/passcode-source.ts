import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  MAX_PASSCODE_ENV_BYTES,
  isPasscodeFile,
  isPasscodeKey,
  type PasscodeBinding,
  type PasscodeSourceState
} from "@shared/run";

/**
 * Debug 密碼的來源：專案環境檔裡的某個鍵。GitNRun 只讀取，不保存、不寫入。
 * 明文只在主程序經手；這裡的函式回傳狀態與值，由呼叫端決定哪些可以交給畫面。
 */

export interface PasscodeFileRead {
  state: PasscodeSourceState;
  /** 只有 state 為 ok 時有值。 */
  value: string | null;
}

export interface PasscodeScanInput {
  /** 各服務工作目錄的絕對路徑。 */
  serviceDirs: readonly string[];
}

export interface PasscodeSourceReader {
  read(folder: string, binding: PasscodeBinding): Promise<PasscodeFileRead>;
  /** 掃描候選綁定：只回檔案與鍵名，不含值。 */
  scan(folder: string, input: PasscodeScanInput): Promise<PasscodeBinding[]>;
  /** 通過安全檢查的環境檔真實路徑；找不到或不安全回傳 null。 */
  locate(folder: string, binding: PasscodeBinding): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// dotenv 解析（純函式）
// ---------------------------------------------------------------------------

const ENV_LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/;

/** 引號內原樣保留；沒有引號時，「空白加 #」之後是行尾註解。 */
const parseEnvValue = (raw: string): string => {
  const value = raw.trim();
  const quote = value[0];
  if (quote === '"' || quote === "'" || quote === "`") {
    const end = value.indexOf(quote, 1);
    return end > 0 ? value.slice(1, end) : value;
  }
  return value.replace(/\s+#.*$/, "").trim();
};

/** 所有鍵與值；同一個鍵重複出現時取最後一筆。 */
export const parseEnvText = (text: string): Map<string, string> => {
  const entries = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = ENV_LINE.exec(line);
    if (match === null) continue;
    const [, key = "", rest = ""] = match;
    entries.set(key, parseEnvValue(rest));
  }
  return entries;
};

/** 環境檔內容裡指定鍵的狀態；空值視為沒設定。 */
export const interpretEnvText = (text: string, key: string): PasscodeFileRead => {
  const value = parseEnvText(text).get(key);
  if (value === undefined) return { state: "no-key", value: null };
  return value === "" ? { state: "empty", value: null } : { state: "ok", value };
};

// ---------------------------------------------------------------------------
// 讀檔（真實檔案系統）
// ---------------------------------------------------------------------------

const isInside = (root: string, candidate: string): boolean => candidate === root || candidate.startsWith(root + sep);

type Located = { path: string } | { state: "no-file" | "unsafe" };

/** 環境檔在專案裡的真實路徑；跳出專案、不是一般檔案或太大都算不安全。 */
const locate = async (folder: string, file: string): Promise<Located> => {
  if (!isPasscodeFile(file)) return { state: "unsafe" };
  const root = await realpath(folder).catch(() => null);
  if (root === null) return { state: "no-file" };
  const real = await realpath(resolve(root, file)).catch(() => null);
  if (real === null) return { state: "no-file" };
  if (!isInside(root, real)) return { state: "unsafe" };
  const info = await stat(real).catch(() => null);
  if (info === null) return { state: "no-file" };
  return info.isFile() && info.size <= MAX_PASSCODE_ENV_BYTES ? { path: real } : { state: "unsafe" };
};

const readEnvFile = async (folder: string, file: string): Promise<{ text: string } | { state: "no-file" | "unsafe" }> => {
  const located = await locate(folder, file);
  if (!("path" in located)) return located;
  try {
    return { text: await readFile(located.path, "utf8") };
  } catch {
    return { state: "no-file" };
  }
};

export const readPasscode = async (folder: string, binding: PasscodeBinding): Promise<PasscodeFileRead> => {
  const read = await readEnvFile(folder, binding.file);
  return "text" in read ? interpretEnvText(read.text, binding.key) : { state: read.state, value: null };
};

// ---------------------------------------------------------------------------
// 候選偵測：所有專案掃同一份環境檔清單，再用鍵名樣式挑出像 Debug 密碼的鍵
// ---------------------------------------------------------------------------

/** 所有專案一律掃同一份清單，順序即優先順序；.dev.vars 是 Cloudflare Worker 用的。 */
const PASSCODE_SCAN_FILES: readonly string[] = [".env.local", ".env.development.local", ".env.development", ".env", ".dev.vars"];
const WORKSPACE_DIRS = ["apps", "packages", "services"] as const;
const MAX_CANDIDATES = 8;
const CANDIDATE_SUFFIX = /(?:PASSWORD|PASSCODE|PWD)$/;
const CANDIDATE_SCOPE = /(?:^|_)(?:DEBUG|DEV|LOCAL)_/;

export const isPasscodeCandidateKey = (key: string): boolean =>
  isPasscodeKey(key) && CANDIDATE_SUFFIX.test(key) && CANDIDATE_SCOPE.test(key);

/** 根目錄、各服務工作目錄，以及 apps／packages／services 底下一層。 */
const scanDirectories = async (folder: string, serviceDirs: readonly string[]): Promise<string[]> => {
  const root = resolve(folder);
  const relatives = new Set<string>([""]);
  for (const dir of serviceDirs) {
    const rel = relative(root, resolve(dir));
    if (!rel.startsWith("..") && !rel.startsWith(sep)) relatives.add(rel.split(sep).join("/"));
  }
  for (const group of WORKSPACE_DIRS) {
    const entries = await readdir(join(root, group), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) relatives.add(`${group}/${entry.name}`);
    }
  }
  return [...relatives];
};

export const scanPasscodeCandidates = async (folder: string, input: PasscodeScanInput): Promise<PasscodeBinding[]> => {
  const candidates: PasscodeBinding[] = [];
  for (const dir of await scanDirectories(folder, input.serviceDirs)) {
    for (const name of PASSCODE_SCAN_FILES) {
      const file = dir === "" ? name : `${dir}/${name}`;
      if (!isPasscodeFile(file)) continue;
      const read = await readEnvFile(folder, file);
      if (!("text" in read)) continue;
      for (const key of parseEnvText(read.text).keys()) {
        if (isPasscodeCandidateKey(key) && candidates.length < MAX_CANDIDATES) candidates.push({ file, key });
      }
    }
  }
  return candidates;
};

export const fsPasscodeSource: PasscodeSourceReader = {
  read: readPasscode,
  scan: scanPasscodeCandidates,
  locate: async (folder, binding) => {
    const located = await locate(folder, binding.file);
    return "path" in located ? located.path : null;
  }
};
