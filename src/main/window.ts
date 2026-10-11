import { join } from "node:path";
import { BrowserWindow, dialog } from "electron";
import { createCrashGuard, inMemoryRestartLog } from "@main/reliability/crash-guard";
import { buildSecureWebPreferences } from "@main/web-preferences";

const PRELOAD_PATH = join(__dirname, "../preload/index.js");

/** 渲染程序崩潰時自動重新載入；一分鐘內崩潰超過三次就停手並告訴使用者。 */
const reloadGuard = createCrashGuard({ maxRestarts: 3, windowMs: 60_000, now: Date.now, ...inMemoryRestartLog() });

const logRendererDiagnostics = (window: BrowserWindow): void => {
  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error("[renderer:preload-error]", preloadPath, error);
  });
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (isMainFrame) {
      console.error("[renderer:did-fail-load]", errorCode, errorDescription, validatedUrl);
    }
  });
  window.webContents.on("console-message", (details) => {
    if (details.level !== "warning" && details.level !== "error") return;
    console.error(`[renderer:${details.level}]`, details.message, details.sourceId ? `${details.sourceId}:${details.lineNumber}` : "");
  });
};

export const createMainWindow = (): BrowserWindow => {
  const window = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 820,
    minHeight: 520,
    show: false,
    title: "devRun",
    webPreferences: buildSecureWebPreferences(PRELOAD_PATH)
  });

  logRendererDiagnostics(window);

  window.once("ready-to-show", () => window.show());

  window.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit" || window.isDestroyed()) {
      return;
    }
    if (reloadGuard.allowRestart()) {
      window.reload();
    } else {
      dialog.showErrorBox("畫面一直當掉", "devRun 的畫面在短時間內當掉了好幾次，已停止自動重新載入。請從 Dock 重新開啟視窗。");
    }
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void window.loadURL(devUrl);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return window;
};

/** 帶出主視窗：不存在就建立，最小化就還原。 */
export const showMainWindow = (): BrowserWindow => {
  const [existing] = BrowserWindow.getAllWindows();
  if (!existing) {
    return createMainWindow();
  }
  if (existing.isMinimized()) {
    existing.restore();
  }
  existing.show();
  existing.focus();
  return existing;
};
