import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, dialog, globalShortcut, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from "electron";
import type { LaunchResult, TerminalAvailability } from "@shared/launcher";
import type { Db } from "@main/db/database";
import { queryEvents } from "@main/db/events-repo";
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
import type { MonitorService } from "@main/monitor/service";
import { buildTrayItems, type TrayAction, type TrayModel } from "@main/tray-menu";
import { TRAY_ICON_PNG_BASE64, TRAY_ICON_SCALE_FACTOR } from "@main/tray-icon";

const EXEC_TIMEOUT_MS = 15_000;

const ITERM_PATHS = ["/Applications/iTerm.app", join(homedir(), "Applications", "iTerm.app")];
const TERMINAL_PATH = "/System/Applications/Utilities/Terminal.app";

export const detectAvailability = (): TerminalAvailability => ({
  terminal: existsSync(TERMINAL_PATH),
  iterm: ITERM_PATHS.some((path) => existsSync(path))
});

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
  showMainWindow: () => void;
  /** 托盤顯示監視狀態並提供暫停／恢復。 */
  monitor: Pick<MonitorService, "status" | "setPaused">;
  /** 監視狀態或事件有變動時通知（托盤選單據此更新）。 */
  onMonitorChange: (listener: () => void) => () => void;
  /** 外部（網址、Dock）送來的開啟請求；啟動器準備好後才會開始處理。 */
  externalGate: ExternalOpenGate;
  onConfigChanged: () => void;
}

export interface LauncherRuntime {
  handlers: LauncherHandlers;
  /** 專案或映射有變動時重建托盤選單。 */
  refreshTray: () => void;
  dispose: () => void;
}

/** 組裝一鍵啟動：快捷鍵、托盤選單、快速選單、外部開啟請求。 */
export const createLauncherRuntime = (deps: LauncherRuntimeDeps): LauncherRuntime => {
  const { db, logger } = deps;

  const launchDeps: LaunchDeps = {
    mappings: () => listMappings(db),
    defaultTerminal: () => readLauncherSettings(db).defaultTerminal,
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

  const targetItems = (): MenuItemConstructorOptions[] => {
    const targets = buildLaunchTargets(listProjects(db), listMappings(db));
    if (targets.length === 0) {
      return [{ label: "尚未設定專案路徑或資料夾映射", enabled: false }];
    }
    return targets.map((target) => ({ label: target.label, click: () => void launch(target.folder) }));
  };

  /** 快捷鍵：啟動「目前選定的專案」；沒選定（或它沒有本機路徑）就在游標位置跳出快速選單。 */
  const onShortcut = (): void => {
    const selectedId = readLauncherSettings(db).selectedProjectId;
    const project = selectedId === null ? null : getProject(db, selectedId);
    if (project?.localPath) {
      void launch(project.localPath);
      return;
    }
    Menu.buildFromTemplate(targetItems()).popup();
  };

  const shortcuts = createShortcutManager(
    { register: (accelerator, callback) => globalShortcut.register(accelerator, callback), unregister: (accelerator) => globalShortcut.unregister(accelerator) },
    onShortcut
  );

  const trayModel = (): TrayModel => {
    const status = deps.monitor.status();
    const projects = listProjects(db);
    const names = new Map(projects.map((project) => [project.id, project.name]));
    return {
      paused: status.paused,
      rateLimitedUntil: status.rateLimitedUntil,
      projectCount: projects.filter((project) => project.enabled).length,
      recentEvents: queryEvents(db, { limit: 5 }).events.map((event) => ({
        label: `${names.get(event.projectId) ?? "專案"} · ${event.branch}${event.pusher ? ` · ${event.pusher}` : ""}`
      })),
      targets: buildLaunchTargets(projects, listMappings(db))
    };
  };

  const runTrayAction = (action: TrayAction): void => {
    switch (action.type) {
      case "open-window":
        deps.showMainWindow();
        return;
      case "toggle-pause":
        deps.monitor.setPaused(!deps.monitor.status().paused);
        return;
      case "launch":
        void launch(action.folder);
        return;
      case "quit":
        app.quit();
    }
  };

  let tray: Tray | null = null;
  const buildTrayMenu = (): Menu =>
    Menu.buildFromTemplate(
      buildTrayItems(trayModel()).map((item): MenuItemConstructorOptions => {
        if (item.kind === "separator") return { type: "separator" };
        if (item.kind === "label") return { label: item.label, enabled: false };
        return { label: item.label, enabled: item.enabled !== false, click: () => runTrayAction(item.action) };
      })
    );

  const refreshTray = (): void => {
    tray?.setContextMenu(buildTrayMenu());
  };

  // 推送一多會連續觸發很多次變動；合併成一次重建。
  let refreshTimer: NodeJS.Timeout | null = null;
  const refreshTraySoon = (): void => {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refreshTray();
    }, 500);
    refreshTimer.unref();
  };
  const stopFollowingMonitor = deps.onMonitorChange(refreshTraySoon);

  const createTray = (): void => {
    const icon = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_PNG_BASE64, "base64"), { scaleFactor: TRAY_ICON_SCALE_FACTOR });
    icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setToolTip("GitNRun");
    tray.setContextMenu(buildTrayMenu());
  };

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
      const { response } = await dialog.showMessageBox({
        type: "question",
        title: "GitNRun",
        message: "有程式要求在終端機開啟這個資料夾",
        detail: `${folder}\n\n這個資料夾沒有設定自動執行的指令，只會開啟一個空白的終端機。`,
        buttons: ["取消", "開啟"],
        defaultId: 0,
        cancelId: 0,
        noLink: true
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
      refreshTray();
    }
  });

  // 啟動時依儲存的設定註冊快捷鍵；被佔用就先不啟用，使用者可以在設定中換一組。
  const initial = readLauncherSettings(db).shortcut;
  if (initial !== null && !shortcuts.apply(initial)) {
    logger.log({ category: "system", level: "warn", message: `全域快捷鍵 ${initial} 已被其他程式使用，尚未啟用` });
  }

  createTray();
  deps.externalGate.attach((request) => void handleExternal(request));

  // 協定只有打包後的 App 才有意義；開發時註冊的會是 Electron 本體。
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
  }

  return {
    handlers,
    refreshTray,
    dispose() {
      stopFollowingMonitor();
      if (refreshTimer) clearTimeout(refreshTimer);
      shortcuts.dispose();
      globalShortcut.unregisterAll();
      tray?.destroy();
      tray = null;
    }
  };
};
