import { BrowserWindow } from "electron";

/** 把資料推給所有開著的視窗（渲染層用 preload 的 on* 方法訂閱）。 */
export const broadcast = (channel: string, payload: unknown): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }
};
