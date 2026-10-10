import type { ScriptableTerminal } from "@shared/launcher";

/**
 * AppleScript 範本。
 *
 * 資料夾路徑與指令「不」組進 script 文字裡，而是當作 osascript 的命令列參數（argv）傳入，
 * 再由 AppleScript 內建的 `quoted form of` 做 shell 引號處理。script 本身是固定常數，
 * 所以資料夾名稱含引號、$、反引號、空白或中文都不可能變成 script 或 shell 的一部分。
 * 使用者設定的指令則刻意交給終端機的 shell 執行（這就是這個功能的目的）。
 */

const TERMINAL_SCRIPT = [
  "on run argv",
  "set theDir to item 1 of argv",
  "set theCmd to item 2 of argv",
  'tell application id "com.apple.Terminal"',
  "activate",
  'if theCmd is "" then',
  'do script "cd " & quoted form of theDir',
  "else",
  'do script "cd " & quoted form of theDir & " && " & theCmd',
  "end if",
  "end tell",
  "end run"
] as const;

const ITERM_SCRIPT = [
  "on run argv",
  "set theDir to item 1 of argv",
  "set theCmd to item 2 of argv",
  'tell application id "com.googlecode.iterm2"',
  "activate",
  "set newWindow to (create window with default profile)",
  "tell current session of newWindow",
  'if theCmd is "" then',
  'write text "cd " & quoted form of theDir',
  "else",
  'write text "cd " & quoted form of theDir & " && " & theCmd',
  "end if",
  "end tell",
  "end tell",
  "end run"
] as const;

/**
 * 專案啟動用：一個新視窗、每個服務一個分頁。argv 以 (資料夾, 分頁名稱, 指令) 三個一組重複。
 * script 一樣是固定常數，資料夾、名稱、指令都不會變成 script 的一部分。
 */
export const ITERM_TABS_SCRIPT = [
  "on run argv",
  "set tabCount to (count of argv) div 3",
  'tell application id "com.googlecode.iterm2"',
  "activate",
  "set newWindow to (create window with default profile)",
  "repeat with i from 0 to (tabCount - 1)",
  "set theDir to item (i * 3 + 1) of argv",
  "set theName to item (i * 3 + 2) of argv",
  "set theCmd to item (i * 3 + 3) of argv",
  "if i is greater than 0 then",
  "tell newWindow to create tab with default profile",
  "end if",
  "tell current session of newWindow",
  "set name to theName",
  'write text "cd " & quoted form of theDir & " && " & theCmd',
  "end tell",
  "end repeat",
  "end tell",
  "end run"
] as const;

export const SCRIPTS: Record<ScriptableTerminal, readonly string[]> = {
  terminal: TERMINAL_SCRIPT,
  iterm: ITERM_SCRIPT
};

export interface ItermTab {
  /** 絕對路徑的工作目錄。 */
  dir: string;
  /** 分頁名稱。 */
  name: string;
  /** 已引用完成的一行指令。 */
  command: string;
}

/** 在 iTerm2 一次開出多個分頁的 osascript 完整參數。 */
export const buildItermTabsArgs = (tabs: readonly ItermTab[]): string[] => [
  ...ITERM_TABS_SCRIPT.flatMap((line) => ["-e", line]),
  "--",
  ...tabs.flatMap((tab) => [tab.dir, tab.name, tab.command])
];

/** osascript 的完整參數：每行 script 一個 -e，最後是 argv（資料夾、指令）。 */
export const buildOsascriptArgs = (app: ScriptableTerminal, folder: string, command: string): string[] => [
  ...SCRIPTS[app].flatMap((line) => ["-e", line]),
  "--",
  folder,
  command
];

/** 只開啟資料夾、不能自動執行指令的終端機（用 `open -a`）。 */
export const buildOpenArgs = (appName: string, folder: string): string[] => ["-a", appName, folder];

export const AUTOMATION_DENIED = /-1743|not authorized to send apple events/i;
