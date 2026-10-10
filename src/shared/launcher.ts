/** 一鍵啟動終端機的共用型別與驗證（純函式）。 */

export const TERMINAL_APP_DEFAULT = "default";
export const TERMINAL_APP_TERMINAL = "terminal";
export const TERMINAL_APP_ITERM = "iterm";

/** 內建支援「開啟並自動執行指令」的終端機。其他終端機只能在資料夾開啟、不能自動執行。 */
export const SCRIPTABLE_TERMINALS = [TERMINAL_APP_TERMINAL, TERMINAL_APP_ITERM] as const;
export type ScriptableTerminal = (typeof SCRIPTABLE_TERMINALS)[number];

export const isScriptableTerminal = (value: string): value is ScriptableTerminal =>
  (SCRIPTABLE_TERMINALS as readonly string[]).includes(value);

export const TERMINAL_LABELS: Record<ScriptableTerminal, string> = {
  terminal: "Terminal（內建）",
  iterm: "iTerm2"
};

export interface TerminalMapping {
  id: number;
  /** 絕對路徑，或帶 * ? 的樣式（如 /Users/me/Projects/*）。 */
  pathPattern: string;
  /** 在該資料夾裡自動執行的一行指令；留空代表只開啟終端機。 */
  command: string;
  /** true：符合資料夾底下的所有子資料夾也套用。 */
  recursive: boolean;
  /** "default"（用全域預設）、"terminal"、"iterm"，或其他終端機 App 的名稱。 */
  terminalApp: string;
}

export interface TerminalMappingInput {
  pathPattern: string;
  command: string;
  recursive: boolean;
  terminalApp: string;
}

export type MappingValidation = { ok: true; value: TerminalMappingInput } | { ok: false; errors: string[] };

const MAX_PATH = 4096;
const MAX_COMMAND = 8192;
const CONTROL = /[\u0000-\u001f\u007f]/;
/** 其他終端機 App 的名稱：交給 `open -a`，只允許一般 App 名稱用得到的字元。 */
export const APP_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._+-]{0,59}$/u;

export const isValidAppName = (value: string): boolean => APP_NAME_PATTERN.test(value) && !value.includes("..");

export const isValidTerminalChoice = (value: string): boolean =>
  value === TERMINAL_APP_DEFAULT || isScriptableTerminal(value) || isValidAppName(value);

/** 去掉結尾的斜線（根目錄除外）。 */
export const normalizeFolderPath = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, "") || "/" : path);

export const hasWildcard = (pattern: string): boolean => /[*?]/.test(pattern);

export const validateMappingInput = (raw: unknown): MappingValidation => {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["輸入格式不正確"] };
  }
  const input = raw as Record<string, unknown>;

  const rawPattern = typeof input.pathPattern === "string" ? input.pathPattern.trim() : "";
  const pathPattern = normalizeFolderPath(rawPattern);
  if (pathPattern.length === 0 || pathPattern.length > MAX_PATH || !pathPattern.startsWith("/") || CONTROL.test(pathPattern)) {
    errors.push("資料夾路徑需為絕對路徑（以 / 開頭），可以用 * 與 ? 當萬用符號");
  } else if (pathPattern.split("/").some((segment) => segment === "..")) {
    errors.push("路徑不可包含 ..");
  }

  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (typeof input.command !== "string" || command.length > MAX_COMMAND) {
    errors.push(`指令最長 ${MAX_COMMAND} 字`);
  } else if (CONTROL.test(command)) {
    errors.push("指令必須是一行；多個步驟請用 && 串接");
  }

  if (typeof input.recursive !== "boolean") {
    errors.push("recursive 需為 true 或 false");
  }

  const terminalApp = typeof input.terminalApp === "string" ? input.terminalApp.trim() : TERMINAL_APP_DEFAULT;
  if (!isValidTerminalChoice(terminalApp)) {
    errors.push("終端機名稱不正確");
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: { pathPattern, command, recursive: input.recursive === true, terminalApp } };
};

// ---------------------------------------------------------------------------
// 全域快捷鍵
// ---------------------------------------------------------------------------

export const DEFAULT_SHORTCUT = "CommandOrControl+Shift+T";

const MODIFIERS = new Set(["command", "cmd", "control", "ctrl", "commandorcontrol", "cmdorctrl", "alt", "option", "altgr", "shift", "super", "meta"]);
const KEY = /^([A-Za-z0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Tab|Backspace|Delete|Insert|Return|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Esc|[`~!@#$%^&*()_=+[\]{};:'",.<>/?\\|-])$/;

/**
 * Electron accelerator 的格式檢查：至少一個修飾鍵（不允許單獨一個鍵，以免搶走一般輸入）、
 * 剛好一個主鍵、修飾鍵不重複。
 */
export const isValidAccelerator = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 60) {
    return false;
  }
  const parts = value.split("+");
  // 主鍵本身可以是 "+"（寫成 "Shift++"）：結尾連著兩個 + 的情況。
  const key = value.endsWith("++") ? "+" : parts[parts.length - 1];
  const modifiers = value.endsWith("++") ? parts.slice(0, -2) : parts.slice(0, -1);
  if (key === undefined || (key !== "+" && !KEY.test(key)) || modifiers.length === 0) {
    return false;
  }
  const lowered = modifiers.map((modifier) => modifier.toLowerCase());
  return lowered.every((modifier) => MODIFIERS.has(modifier)) && new Set(lowered).size === lowered.length;
};

// ---------------------------------------------------------------------------
// 啟動結果
// ---------------------------------------------------------------------------

export type LaunchFailureReason =
  | "not-absolute"
  | "missing"
  | "not-directory"
  | "app-missing"
  | "permission-denied"
  | "failed";

export type LaunchResult =
  | { ok: true; folder: string; app: string; command: string | null; mappingId: number | null }
  | { ok: false; reason: LaunchFailureReason; message: string };

export interface LauncherSettings {
  /** 全域快捷鍵；null = 不使用。 */
  shortcut: string | null;
  shortcutRegistered: boolean;
  defaultTerminal: string;
  selectedProjectId: number | null;
}

export interface TerminalAvailability {
  terminal: boolean;
  iterm: boolean;
}

export interface LaunchTarget {
  label: string;
  folder: string;
}
