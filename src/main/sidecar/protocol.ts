/**
 * 外殼（Tauri 的 Rust 層）與核心（Node sidecar）之間的訊息格式：unix socket 上的逐行 JSON（NDJSON）。
 *
 * 三種訊息，雙向、各自編號（id 只在發送方範圍內唯一，回應 res 只會回給原本的發送方）：
 *   req：要求對方做事並等回應
 *   res：對 req 的回應，成功帶 v（沒有 v 代表 undefined），失敗帶 e
 *   evt：單向通知，不等回應
 *
 * Rust 不解讀通道或參數，只轉發；所有驗證都在核心。方法名稱集中在這裡，Rust 端使用相同字串。
 */

export const PROTOCOL_VERSION = 1;

/** 單一訊息（一行）的大小上限；超過就斷線，避免被塞爆記憶體。 */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export type Frame =
  | { k: "req"; id: number; m: string; p?: unknown }
  | { k: "res"; id: number; ok: true; v?: unknown }
  | { k: "res"; id: number; ok: false; e: WireError }
  | { k: "evt"; m: string; p?: unknown };

export interface WireError {
  name: string;
  message: string;
}

/** Rust → 核心 的請求 */
export const HOST_REQUEST = {
  hello: "hello",
  ipcInvoke: "ipc.invoke"
} as const;

/** Rust → 核心 的事件 */
export const HOST_EVENT = {
  externalOpen: "external-open",
  shortcut: "shortcut",
  notificationClick: "notification-click",
  menuSelect: "menu-select",
  secondInstance: "second-instance",
  quit: "app.quit"
} as const;

/** 核心 → Rust 的事件 */
export const CORE_EVENT = {
  ready: "ready",
  push: "push",
  cancel: "native.cancel"
} as const;

/** 核心 → Rust 的請求（原生能力） */
export const NATIVE = {
  focusMainWindow: "native.window.focus",
  confirm: "native.dialog.confirm",
  openFile: "native.dialog.open",
  saveFile: "native.dialog.save",
  errorBox: "native.errorBox",
  dockBounce: "native.dock.bounce",
  notify: "native.notify",
  clipboardWrite: "native.clipboard.write",
  clipboardWriteExpiring: "native.clipboard.writeExpiring",
  openExternal: "native.openExternal",
  masterKey: "native.keychain.masterKey",
  shortcutRegister: "native.shortcut.register",
  shortcutUnregister: "native.shortcut.unregister",
  shortcutUnregisterAll: "native.shortcut.unregisterAll",
  menuPopup: "native.menu.popup"
} as const;

/** sidecar 的結束碼：Rust 依此決定要不要重生。 */
export const EXIT_RESTART = 75;
export const EXIT_NO_RESTART = 78;

/** hello 帶來的外殼資訊（Rust 啟動時就知道的事）。 */
export interface HostInfo {
  /** 協定版本；不相符就拒絕。 */
  v: number;
  token: string;
  appName: string;
  appVersion: string;
  platform: string;
  /** 使用者資料根目錄（沿用既有的 devRun 目錄，不搬資料）。 */
  dataDir: string;
  /** 打包版才會註冊 URL scheme。 */
  packaged: boolean;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isMethod = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(value);

/** 嚴格檢查訊息形狀；任何不符合的一律回傳 null（呼叫端會斷線）。 */
export const parseFrame = (line: string): Frame | null => {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isPlainObject(raw)) {
    return null;
  }

  if (raw.k === "req" && isId(raw.id) && isMethod(raw.m)) {
    return { k: "req", id: raw.id, m: raw.m, ...("p" in raw ? { p: raw.p } : {}) };
  }
  if (raw.k === "evt" && isMethod(raw.m)) {
    return { k: "evt", m: raw.m, ...("p" in raw ? { p: raw.p } : {}) };
  }
  if (raw.k === "res" && isId(raw.id)) {
    if (raw.ok === true) {
      return { k: "res", id: raw.id, ok: true, ...("v" in raw ? { v: raw.v } : {}) };
    }
    if (raw.ok === false && isPlainObject(raw.e) && typeof raw.e.name === "string" && typeof raw.e.message === "string") {
      return { k: "res", id: raw.id, ok: false, e: { name: raw.e.name, message: raw.e.message } };
    }
  }
  return null;
};

export const encodeFrame = (frame: Frame): string => `${JSON.stringify(frame)}\n`;

export const toWireError = (error: unknown): WireError => {
  if (error instanceof Error) {
    return { name: error.name || "Error", message: error.message };
  }
  return { name: "Error", message: typeof error === "string" ? error : "unknown error" };
};
