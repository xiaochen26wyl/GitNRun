import type { NativeBridge } from "@main/native/bridge";

export interface NativeCall {
  method: string;
  args: unknown[];
}

export interface FakeNative {
  bridge: NativeBridge;
  /** 依呼叫順序記下每次呼叫的方法與參數。 */
  calls: NativeCall[];
  callsOf(method: string): NativeCall[];
}

/** 不碰任何真實外殼的 NativeBridge，測試用；用 overrides 換掉想控制的行為。 */
export const createFakeNative = (overrides: Partial<NativeBridge> = {}): FakeNative => {
  const calls: NativeCall[] = [];
  const record = (method: string, ...args: unknown[]): void => {
    calls.push({ method, args });
  };

  const bridge: NativeBridge = {
    appInfo: () => ({ name: "fake", version: "0.0.0", platform: "test" }),
    dataDir: () => "/tmp/gitnrun-fake-native",
    push: (channel, payload) => record("push", channel, payload),
    focusMainWindow: () => record("focusMainWindow"),
    // 預設像使用者按了「取消按鈕」。
    confirm: async (request) => {
      record("confirm", request);
      return request.cancelId;
    },
    showSaveDialog: async (options) => {
      record("showSaveDialog", options);
      return { canceled: true };
    },
    showOpenFileDialog: async (options) => {
      record("showOpenFileDialog", options);
      return { canceled: true, filePaths: [] };
    },
    showErrorBox: (title, content) => record("showErrorBox", title, content),
    bounceDock: () => record("bounceDock"),
    notify: (title, body) => {
      record("notify", title, body);
      return true;
    },
    clipboardWrite: async (text) => record("clipboardWrite", text),
    clipboardWriteExpiring: async (text, ttlMs) => record("clipboardWriteExpiring", text, ttlMs),
    openExternal: async (url) => record("openExternal", url),
    shortcutRegister: async (accelerator) => {
      record("shortcutRegister", accelerator);
      return true;
    },
    shortcutUnregister: async (accelerator) => record("shortcutUnregister", accelerator),
    shortcutUnregisterAll: async () => record("shortcutUnregisterAll"),
    popupMenu: (entries) => record("popupMenu", entries),
    registerUrlScheme: (scheme) => record("registerUrlScheme", scheme),
    relaunch: () => record("relaunch"),
    exit: (code) => record("exit", code),
    ...overrides
  };

  return { bridge, calls, callsOf: (method) => calls.filter((call) => call.method === method) };
};
