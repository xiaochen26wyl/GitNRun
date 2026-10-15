import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { TERMINAL_APP_ITERM, TERMINAL_APP_TERMINAL, type LaunchResult, type TerminalAvailability } from "@shared/launcher";
import type { Db } from "@main/db/database";
import { listMappings } from "@main/db/mappings-repo";
import { getProject, listProjects } from "@main/db/projects-repo";
import { createLauncherHandlers, type LauncherHandlers } from "@main/launcher/handlers";
import type { ExternalOpenGate, ExternalRequest } from "@main/launcher/external";
import { launchTerminal, type LaunchDeps } from "@main/launcher/launch";
import { PROTOCOL_SCHEME, parseLaunchUrl } from "@main/launcher/protocol";
import { resolveMapping, buildLaunchTargets } from "@main/launcher/resolve";
import { readLauncherSettings } from "@main/launcher/settings";
import { createShortcutManager } from "@main/launcher/shortcut";
import type { Logger } from "@main/logger";
import { native, type MenuEntry } from "@main/native/bridge";

const EXEC_TIMEOUT_MS = 15_000;

const ITERM_PATHS = ["/Applications/iTerm.app", join(homedir(), "Applications", "iTerm.app")];
const TERMINAL_PATH = "/System/Applications/Utilities/Terminal.app";

export const detectAvailability = (): TerminalAvailability => ({
  terminal: existsSync(TERMINAL_PATH),
  iterm: ITERM_PATHS.some((path) => existsSync(path))
});

const preferredDefaultTerminal = (): string => (detectAvailability().iterm ? TERMINAL_APP_ITERM : TERMINAL_APP_TERMINAL);

export const run = (file: string, args: readonly string[]): Promise<{ code: number; stderr: string }> =>
  new Promise((resolve) => {
    execFile(file, [...args], { timeout: EXEC_TIMEOUT_MS }, (error, _stdout, stderr) => {
      // 非 0 結束時 error.code 是數字；無法啟動（ENOENT 等）時是字串，一律視為 1。
      const exitCode: unknown = error ? (error as { code?: unknown }).code : 0;
      resolve({ code: typeof exitCode === "number" ? exitCode : 1, stderr: stderr || (error ? error.message : "") });
    });
  });

const inspect = async (path: string): Promise<"dir" | "file" | "missing"> => {
  const info = await stat(path).catch(() => null);
  return info === null ? "missing" : info.isDirectory() ? "dir" : "file";
};

export interface LauncherRuntimeDeps {
  db: Db;
  logger: Logger;
  /** 外部（網址、Dock）送來的開啟請求；啟動器準備好後才會開始處理。 */
  externalGate: ExternalOpenGate;
  onConfigChanged: () => void;
}

export interface LauncherRuntime {
  handlers: LauncherHandlers;
  dispose: () => Promise<void>;
}

/** 組裝一鍵啟動：快捷鍵、快速選單、外部開啟請求。 */
export const createLauncherRuntime = (deps: LauncherRuntimeDeps): LauncherRuntime => {
  const { db, logger } = deps;

  const launchDeps: LaunchDeps = {
    mappings: () => listMappings(db),
    defaultTerminal: () => readLauncherSettings(db, preferredDefaultTerminal()).defaultTerminal,
    available: detectAvailability,
    inspect,
    exec: run
  };

  const launch = async (folder: string): Promise<LaunchResult> => {
    const result = await launchTerminal(launchDeps, folder);
    logger.log({
      category: "command",
      level: result.ok ? "info" : "warn",
      message: result.ok ? `已在 ${result.app} 開啟 ${result.folder}${result.command ? `並執行：${result.command}` : ""}` : `無法開啟終端機：${result.message}`
    });
    return result;
  };

  const targetItems = (): MenuEntry[] => {
    const targets = buildLaunchTargets(listProjects(db), listMappings(db));
    if (targets.length === 0) {
      return [{ label: "尚未設定專案路徑或資料夾映射", enabled: false }];
    }
    return targets.map((target) => ({ label: target.label, onClick: () => void launch(target.folder) }));
  };

  /** 快捷鍵：啟動「目前選定的專案」；沒選定（或它沒有本機路徑）就在游標位置跳出快速選單。 */
  const onShortcut = (): void => {
    const selectedId = readLauncherSettings(db, preferredDefaultTerminal()).selectedProjectId;
    const project = selectedId === null ? null : getProject(db, selectedId);
    if (project?.localPath) {
      void launch(project.localPath);
      return;
    }
    native().popupMenu(targetItems());
  };

  const shortcuts = createShortcutManager(
    {
      register: (accelerator, callback) => native().shortcutRegister(accelerator, callback),
      unregister: (accelerator) => native().shortcutUnregister(accelerator)
    },
    onShortcut
  );

  /** 來自外部的請求不可信：只有「已有映射」的資料夾才直接啟動，其餘要先問使用者。 */
  const handleExternal = async (request: ExternalRequest): Promise<void> => {
    let folder: string;
    let askFirst: boolean;

    if (request.kind === "url") {
      const parsed = parseLaunchUrl(request.value);
      if (!parsed.ok) {
        logger.log({ category: "system", level: "warn", message: "忽略了格式不正確的 gitnrun:// 網址" });
        return;
      }
      folder = parsed.folder;
      askFirst = resolveMapping(listMappings(db), folder) === null;
    } else {
      // 拖到 Dock 圖示上的資料夾是使用者自己的操作，不需要再確認。
      folder = request.value;
      askFirst = false;
    }

    if (askFirst) {
      const response = await native().confirm({
        kind: "question",
        title: "devRun",
        message: "有程式要求在終端機開啟這個資料夾",
        detail: `${folder}\n\n這個資料夾沒有設定自動執行的指令，只會開啟一個空白的終端機。`,
        buttons: ["取消", "開啟"],
        defaultId: 0,
        cancelId: 0
      });
      if (response !== 1) {
        return;
      }
    }
    await launch(folder);
  };

  const handlers = createLauncherHandlers({
    db,
    launch,
    shortcuts,
    availability: detectAvailability,
    onConfigChanged: () => {
      deps.onConfigChanged();
    }
  });

  // 啟動時依儲存的設定註冊快捷鍵；被佔用就先不啟用，使用者可以在設定中換一組。
  const initial = readLauncherSettings(db).shortcut;
  if (initial !== null) {
    void shortcuts.apply(initial).then((registered) => {
      if (!registered) {
        logger.log({ category: "system", level: "warn", message: `全域快捷鍵 ${initial} 已被其他程式使用，尚未啟用` });
      }
    });
  }

  deps.externalGate.attach((request) => void handleExternal(request));

  native().registerUrlScheme(PROTOCOL_SCHEME);

  return {
    handlers,
    async dispose() {
      await shortcuts.dispose();
      await native().shortcutUnregisterAll();
    }
  };
};
