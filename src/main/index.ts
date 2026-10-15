import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, nativeImage } from "electron";
import { startCore } from "@main/bootstrap";
import { attachElectronIpc } from "@main/electron-ipc-adapter";
import { createExternalOpenGate } from "@main/launcher/external";
import { setNative } from "@main/native/bridge";
import { createElectronNativeBridge } from "@main/native/electron-bridge";
import { safeStorageCipher } from "@main/vault/safe-storage-cipher";
import { installSessionLockdown, installWebContentsHardening } from "@main/window-hardening";
import { createMainWindow, showMainWindow } from "@main/window";

// Electron 外殼的入口：視窗、選單、系統事件都在這裡；其餘邏輯在 bootstrap（與外殼無關）。

// 在任何視窗建立之前就安裝鎖定。
installWebContentsHardening();

// macOS 可能在 App 還沒準備好時就送來 open-url／open-file（例如從 Finder 的快速動作冷啟動）：
// 先接住，等啟動器準備好再依序處理。
const externalGate = createExternalOpenGate();
app.on("open-url", (event, url) => {
  event.preventDefault();
  externalGate.push({ kind: "url", value: url });
});
app.on("open-file", (event, path) => {
  event.preventDefault();
  externalGate.push({ kind: "file", value: path });
});

/** 開發模式的 Dock 會顯示 Electron 圖示，改成專案 logo；打包版由 build/icon.icns 負責。 */
const applyDevDockIcon = (): void => {
  if (app.isPackaged || !app.dock) return;
  const iconPath = join(__dirname, "../../build/icon.png");
  if (existsSync(iconPath)) {
    app.dock.setIcon(nativeImage.createFromPath(iconPath));
  }
};

const bootstrap = (): void => {
  installSessionLockdown();
  applyDevDockIcon();

  setNative(createElectronNativeBridge());
  const core = startCore({ externalGate, cipher: safeStorageCipher });

  app.on("child-process-gone", (_event, details) => {
    core.logger.log({ category: "system", level: "error", message: `子行程異常結束：${details.type}（${details.reason}）` });
  });

  attachElectronIpc();
  createMainWindow();

  app.on("will-quit", () => core.releaseShortcuts());
  app.on("before-quit", () => core.stop());
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => void showMainWindow());
  void app.whenReady().then(bootstrap);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });

  // 關閉視窗只是銷毀畫面（渲染程序），快捷鍵留在主程序裡繼續運作；要結束請用 Cmd+Q。
  app.on("window-all-closed", () => undefined);
}
