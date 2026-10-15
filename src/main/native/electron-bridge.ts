import { app, BrowserWindow, clipboard, dialog, globalShortcut, Menu, Notification, shell } from "electron";
import type { NativeBridge } from "@main/native/bridge";
import { showMainWindow } from "@main/window";

/**
 * Electron 版的外殼實作。遷移期間讓 Electron 版維持可執行，作為與 Tauri 並排對照的基準；
 * 對等驗證通過、移除 Electron 時整個檔案一併刪除。
 */

const focusedWindow = (): BrowserWindow | undefined => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];

export const createElectronNativeBridge = (): NativeBridge => ({
  appInfo: () => ({ name: app.getName(), version: app.getVersion(), platform: process.platform }),
  dataDir: () => app.getPath("userData"),

  push(channel, payload) {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, payload);
      }
    }
  },
  focusMainWindow: () => void showMainWindow(),

  async confirm(request, options) {
    const { response } = await dialog.showMessageBox({
      type: request.kind,
      title: request.title,
      message: request.message,
      detail: request.detail,
      buttons: [...request.buttons],
      defaultId: request.defaultId,
      cancelId: request.cancelId,
      noLink: true,
      ...(options?.signal ? { signal: options.signal } : {})
    });
    return response;
  },

  async showSaveDialog(options) {
    const dialogOptions = {
      title: options.title,
      defaultPath: options.defaultPath,
      filters: options.filters.map((filter) => ({ name: filter.name, extensions: [...filter.extensions] }))
    };
    const window = focusedWindow();
    const result = window ? await dialog.showSaveDialog(window, dialogOptions) : await dialog.showSaveDialog(dialogOptions);
    return { canceled: result.canceled, ...(result.filePath ? { filePath: result.filePath } : {}) };
  },

  async showOpenFileDialog(options) {
    const dialogOptions = {
      title: options.title,
      properties: ["openFile" as const],
      filters: options.filters.map((filter) => ({ name: filter.name, extensions: [...filter.extensions] }))
    };
    const window = focusedWindow();
    const result = window ? await dialog.showOpenDialog(window, dialogOptions) : await dialog.showOpenDialog(dialogOptions);
    return { canceled: result.canceled, filePaths: result.filePaths };
  },

  showErrorBox: (title, content) => dialog.showErrorBox(title, content),
  bounceDock: () => void app.dock?.bounce("critical"),

  notify(title, body, onClick) {
    if (!Notification.isSupported()) {
      return false;
    }
    const notification = new Notification({ title, body });
    if (onClick) {
      notification.on("click", onClick);
    }
    notification.show();
    return true;
  },

  async clipboardWrite(text) {
    clipboard.writeText(text);
  },

  async clipboardWriteExpiring(text, ttlMs) {
    clipboard.writeText(text);
    setTimeout(() => {
      if (clipboard.readText() === text) {
        clipboard.clear();
      }
    }, ttlMs).unref();
  },

  openExternal: (url) => shell.openExternal(url),

  async shortcutRegister(accelerator, onTrigger) {
    return globalShortcut.register(accelerator, onTrigger);
  },
  async shortcutUnregister(accelerator) {
    globalShortcut.unregister(accelerator);
  },
  async shortcutUnregisterAll() {
    globalShortcut.unregisterAll();
  },
  popupMenu(entries) {
    Menu.buildFromTemplate(
      entries.map((entry) => ({
        label: entry.label,
        ...(entry.enabled === undefined ? {} : { enabled: entry.enabled }),
        ...(entry.onClick ? { click: entry.onClick } : {})
      }))
    ).popup();
  },

  registerUrlScheme(scheme) {
    // 協定只有打包後的 App 才有意義；開發時註冊的會是 Electron 本體。
    if (app.isPackaged) {
      app.setAsDefaultProtocolClient(scheme);
    }
  },

  relaunch() {
    app.relaunch();
    app.exit(0);
  },
  exit: (code) => app.exit(code)
});
