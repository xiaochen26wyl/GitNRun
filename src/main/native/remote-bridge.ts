import type { MenuEntry, NativeBridge } from "@main/native/bridge";
import type { SidecarServer } from "@main/sidecar/server";
import { EXIT_RESTART, HOST_EVENT, NATIVE, type HostInfo } from "@main/sidecar/protocol";

/**
 * Tauri 版的外殼實作：每項原生能力都轉成對 Rust 的請求（方法名在 sidecar/protocol 的 NATIVE），
 * 需要「之後回呼」的能力（通知點擊、快捷鍵、選單）用編號或快捷鍵字串對應，Rust 以事件送回。
 * 負載只經過連線，不寫進日誌。
 */

export interface RemoteBridgeDeps {
  server: SidecarServer;
  info: Omit<HostInfo, "token">;
  /** 結束行程（測試可注入）。 */
  exit: (code: number) => void;
}

export interface RemoteBridge {
  bridge: NativeBridge;
  /** 外殼送來的事件；回傳 true 表示由橋接處理。 */
  handleEvent(method: string, payload: unknown): boolean;
  /** 外殼重新連上（例如 Rust 重編重啟）後，把先前註冊的全域快捷鍵再註冊一次。 */
  restoreAfterReconnect(): Promise<void>;
}

const MAX_NOTIFICATION_CALLBACKS = 50;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const createRemoteNativeBridge = (deps: RemoteBridgeDeps): RemoteBridge => {
  const { server, info } = deps;
  const shortcuts = new Map<string, () => void>();
  const notifications = new Map<number, () => void>();
  let nextNotificationId = 1;
  let menuHandlers: Array<(() => void) | undefined> = [];

  // 沒有需要等結果的呼叫（例如 Dock 彈跳）失敗只是少一個效果，不該變成未處理的 Promise 拒絕。
  const fireAndForget = (method: string, params?: unknown): void => {
    void server.request(method, params).catch(() => undefined);
  };

  const bridge: NativeBridge = {
    appInfo: () => ({ name: info.appName, version: info.appVersion, platform: info.platform }),
    dataDir: () => info.dataDir,

    push: (channel, payload) => server.push(channel, payload),
    focusMainWindow: () => fireAndForget(NATIVE.focusMainWindow),

    async confirm(request, options) {
      try {
        const answer = await server.request(NATIVE.confirm, request, options?.signal ? { signal: options.signal } : {});
        return typeof answer === "number" ? answer : request.cancelId;
      } catch {
        // 逾時中止或外殼斷線都視為取消；呼叫端自己看 signal.aborted 判斷是不是逾時。
        return request.cancelId;
      }
    },

    async showSaveDialog(options) {
      const result = await server.request(NATIVE.saveFile, options);
      if (!isPlainObject(result) || result.canceled === true || typeof result.filePath !== "string") {
        return { canceled: true };
      }
      return { canceled: false, filePath: result.filePath };
    },

    async showOpenFileDialog(options) {
      const result = await server.request(NATIVE.openFile, options);
      if (!isPlainObject(result) || result.canceled === true || !Array.isArray(result.filePaths)) {
        return { canceled: true, filePaths: [] };
      }
      return { canceled: false, filePaths: result.filePaths.filter((path): path is string => typeof path === "string") };
    },

    showErrorBox: (title, content) => fireAndForget(NATIVE.errorBox, { title, content }),
    bounceDock: () => fireAndForget(NATIVE.dockBounce),

    notify(title, body, onClick) {
      if (!server.connected()) {
        return false;
      }
      let id = 0;
      if (onClick) {
        id = nextNotificationId;
        nextNotificationId += 1;
        notifications.set(id, onClick);
        // 只留最近的幾個，沒被點的通知不會讓表無限長大。
        if (notifications.size > MAX_NOTIFICATION_CALLBACKS) {
          const oldest = notifications.keys().next().value;
          if (oldest !== undefined) {
            notifications.delete(oldest);
          }
        }
      }
      fireAndForget(NATIVE.notify, { title, body, id });
      return true;
    },

    async clipboardWrite(text) {
      await server.request(NATIVE.clipboardWrite, { text });
    },
    async clipboardWriteExpiring(text, ttlMs) {
      await server.request(NATIVE.clipboardWriteExpiring, { text, ttlMs });
    },
    async openExternal(url) {
      await server.request(NATIVE.openExternal, { url });
    },

    async shortcutRegister(accelerator, onTrigger) {
      try {
        const ok = await server.request(NATIVE.shortcutRegister, { accelerator });
        if (ok === true) {
          shortcuts.set(accelerator, onTrigger);
          return true;
        }
      } catch {
        // 外殼不接受或斷線：同樣回報註冊失敗，走既有的「註冊失敗」顯示。
      }
      return false;
    },
    async shortcutUnregister(accelerator) {
      shortcuts.delete(accelerator);
      await server.request(NATIVE.shortcutUnregister, { accelerator }).catch(() => undefined);
    },
    async shortcutUnregisterAll() {
      shortcuts.clear();
      await server.request(NATIVE.shortcutUnregisterAll).catch(() => undefined);
    },

    popupMenu(entries: readonly MenuEntry[]) {
      menuHandlers = entries.map((entry) => entry.onClick);
      fireAndForget(NATIVE.menuPopup, {
        items: entries.map((entry, index) => ({ id: index, label: entry.label, enabled: entry.enabled !== false }))
      });
    },

    // URL scheme 由外殼的 Info.plist 負責，核心這邊不需要做事。
    registerUrlScheme: () => undefined,

    relaunch: () => deps.exit(EXIT_RESTART),
    exit: (code) => deps.exit(code)
  };

  return {
    bridge,

    handleEvent(method, payload) {
      if (method === HOST_EVENT.shortcut && isPlainObject(payload) && typeof payload.accelerator === "string") {
        shortcuts.get(payload.accelerator)?.();
        return true;
      }
      if (method === HOST_EVENT.notificationClick && isPlainObject(payload) && typeof payload.id === "number") {
        const callback = notifications.get(payload.id);
        notifications.delete(payload.id);
        callback?.();
        return true;
      }
      if (method === HOST_EVENT.menuSelect && isPlainObject(payload) && typeof payload.id === "number") {
        const handler = menuHandlers[payload.id];
        menuHandlers = [];
        handler?.();
        return true;
      }
      return false;
    },

    async restoreAfterReconnect() {
      for (const accelerator of [...shortcuts.keys()]) {
        await server.request(NATIVE.shortcutRegister, { accelerator }).catch(() => undefined);
      }
    }
  };
};
