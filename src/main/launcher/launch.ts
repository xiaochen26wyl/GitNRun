import {
  TERMINAL_APP_DEFAULT,
  TERMINAL_APP_ITERM,
  TERMINAL_APP_TERMINAL,
  TERMINAL_LABELS,
  isScriptableTerminal,
  isValidAppName,
  normalizeFolderPath,
  type LaunchResult,
  type TerminalAvailability,
  type TerminalMapping
} from "@shared/launcher";
import { redactSecrets } from "@main/log-redaction";
import { AUTOMATION_DENIED, buildOpenArgs, buildOsascriptArgs } from "@main/launcher/osascript";
import { resolveMapping } from "@main/launcher/resolve";

/**
 * 一鍵啟動終端機：偵測資料夾 → 查映射 → 驗證 → 開啟終端機 → 自動執行指令。
 * 系統互動（檔案檢查、執行 osascript／open）都由外部注入，所以整條流程可以不開任何視窗地測試。
 */

export interface LaunchDeps {
  mappings: () => TerminalMapping[];
  defaultTerminal: () => string;
  available: () => TerminalAvailability;
  /** "dir" | "file" | "missing" */
  inspect: (path: string) => Promise<"dir" | "file" | "missing">;
  exec: (file: string, args: readonly string[]) => Promise<{ code: number; stderr: string }>;
}

const ERROR_TEXT_MAX = 300;

const fail = (reason: Extract<LaunchResult, { ok: false }>["reason"], message: string): LaunchResult => ({ ok: false, reason, message });

export const launchTerminal = async (deps: LaunchDeps, requestedFolder: string): Promise<LaunchResult> => {
  if (typeof requestedFolder !== "string" || !requestedFolder.startsWith("/") || requestedFolder.includes("\0") || requestedFolder.length > 4096) {
    return fail("not-absolute", "資料夾路徑必須是絕對路徑");
  }
  const folder = normalizeFolderPath(requestedFolder);

  const kind = await deps.inspect(folder);
  if (kind === "missing") return fail("missing", "找不到這個資料夾");
  if (kind === "file") return fail("not-directory", "這個路徑不是資料夾");

  const resolved = resolveMapping(deps.mappings(), folder);
  const command = resolved?.mapping.command.trim() ?? "";
  const choice = resolved && resolved.mapping.terminalApp !== TERMINAL_APP_DEFAULT ? resolved.mapping.terminalApp : deps.defaultTerminal();
  const app = choice === TERMINAL_APP_DEFAULT ? TERMINAL_APP_TERMINAL : choice;

  let file: string;
  let args: string[];
  let appLabel: string;

  if (isScriptableTerminal(app)) {
    if (app === TERMINAL_APP_ITERM && !deps.available().iterm) {
      return fail("app-missing", "找不到 iTerm2，請改用其他終端機");
    }
    file = "/usr/bin/osascript";
    args = buildOsascriptArgs(app, folder, command);
    appLabel = TERMINAL_LABELS[app];
  } else if (isValidAppName(app)) {
    // 其他終端機：只能在該資料夾開啟，無法自動執行指令。
    file = "/usr/bin/open";
    args = buildOpenArgs(app, folder);
    appLabel = app;
  } else {
    return fail("failed", "終端機名稱不正確");
  }

  const result = await deps.exec(file, args);
  if (result.code !== 0) {
    if (AUTOMATION_DENIED.test(result.stderr)) {
      return fail("permission-denied", "macOS 沒有允許 devRun 控制終端機。請到「系統設定 → 隱私權與安全性 → 自動化」開啟後再試一次。");
    }
    return fail("failed", `無法開啟終端機：${redactSecrets(result.stderr.trim()).slice(0, ERROR_TEXT_MAX) || "未知錯誤"}`);
  }

  return {
    ok: true,
    folder,
    app: appLabel,
    // 其他終端機不會執行指令，所以如實回報沒有執行。
    command: isScriptableTerminal(app) && command ? command : null,
    mappingId: resolved?.mapping.id ?? null
  };
};
