import type { AppInfo } from "@shared/ipc";

/**
 * 主程序需要「外殼」（Tauri）才能做的事，全部收在這個介面。
 * 核心邏輯只透過 native() 取用，不直接碰任何外殼 API，所以換外殼不用改核心。
 */

export interface NativeConfirm {
  kind: "warning" | "question";
  title: string;
  message: string;
  detail: string;
  buttons: readonly string[];
  defaultId: number;
  cancelId: number;
}

export interface FileDialogFilter {
  name: string;
  extensions: readonly string[];
}

export interface SaveDialogOptions {
  title: string;
  defaultPath: string;
  filters: readonly FileDialogFilter[];
}

export interface OpenFileDialogOptions {
  title: string;
  filters: readonly FileDialogFilter[];
}

export interface MenuEntry {
  label: string;
  enabled?: boolean;
  onClick?: () => void;
}

export interface NativeBridge {
  appInfo(): AppInfo;
  /** 使用者資料根目錄；資料庫在其下的 data/，重啟記錄在根目錄。 */
  dataDir(): string;

  /** 推給所有開著的視窗（渲染層用 on* 訂閱）。 */
  push(channel: string, payload: unknown): void;
  focusMainWindow(): void;

  /**
   * 原生確認框，回傳按下的按鈕索引。signal 中止時對話框關閉並以 cancelId 結束，
   * 呼叫端自己看 signal.aborted 判斷是不是逾時。
   */
  confirm(request: NativeConfirm, options?: { signal?: AbortSignal }): Promise<number>;
  showSaveDialog(options: SaveDialogOptions): Promise<{ canceled: boolean; filePath?: string }>;
  showOpenFileDialog(options: OpenFileDialogOptions): Promise<{ canceled: boolean; filePaths: string[] }>;
  showErrorBox(title: string, content: string): void;
  bounceDock(): void;

  /** 顯示桌面通知；系統不支援時回傳 false。點擊通知時呼叫 onClick。 */
  notify(title: string, body: string, onClick?: () => void): boolean;

  clipboardWrite(text: string): Promise<void>;
  /** 寫入剪貼簿，到期時只在內容仍是 text 的情況下清掉，不會誤刪使用者後來複製的東西。 */
  clipboardWriteExpiring(text: string, ttlMs: number): Promise<void>;
  openExternal(url: string): Promise<void>;

  /** 註冊全域快捷鍵；成功回傳 true，被占用或格式不被接受時回傳 false。 */
  shortcutRegister(accelerator: string, onTrigger: () => void): Promise<boolean>;
  shortcutUnregister(accelerator: string): Promise<void>;
  shortcutUnregisterAll(): Promise<void>;
  /** 在游標位置彈出選單；項目被選到時呼叫對應的 onClick。 */
  popupMenu(entries: readonly MenuEntry[]): void;

  /** 讓系統把這個 URL scheme 交給本 App（只有打包版才有意義）。 */
  registerUrlScheme(scheme: string): void;

  /** 重新啟動整個 App。 */
  relaunch(): void;
  exit(code: number): void;
}

let current: NativeBridge | null = null;

export const setNative = (bridge: NativeBridge | null): void => {
  current = bridge;
};

export const native = (): NativeBridge => {
  if (!current) {
    throw new Error("native bridge is not initialised");
  }
  return current;
};
