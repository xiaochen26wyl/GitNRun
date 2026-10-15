import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { invokeChannel, registeredChannels } from "@main/ipc";
import { isTrustedUrl } from "@main/window-hardening";

/**
 * 發送端必須是本 app 自己打包頁面的主 frame；其他來源（子 frame、被導航走的頁面）一律拒絕。
 */
const isTrustedSender = (event: IpcMainInvokeEvent): boolean => {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) {
    return false;
  }
  return isTrustedUrl(frame.url);
};

/** 把註冊表裡的每個通道掛到 ipcMain；所有 register*Ipc 都完成之後呼叫一次。 */
export const attachElectronIpc = (): void => {
  for (const channel of registeredChannels()) {
    ipcMain.handle(channel, async (event, ...rawArgs: unknown[]) => {
      if (!isTrustedSender(event)) {
        const error = new Error("ipc: untrusted sender");
        console.error(`[ipc:${channel}]`, error);
        throw error;
      }
      return invokeChannel(channel, rawArgs);
    });
  }
};
