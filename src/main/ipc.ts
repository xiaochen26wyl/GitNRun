import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { IpcChannel } from "@shared/ipc";
import { runValidated, type ArgsValidator } from "@main/ipc-validation";
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

/**
 * 全 app 唯一註冊 IPC handler 的入口：通道必須在 shared/ipc 宣告過，
 * 每次呼叫先驗證發送端，再驗證入參，通過後才進到 handler。
 */
export const handleIpc = <A extends unknown[], R>(
  channel: IpcChannel,
  validate: ArgsValidator<A>,
  handler: (...args: A) => R | Promise<R>
): void => {
  ipcMain.handle(channel, async (event, ...rawArgs: unknown[]) => {
    try {
      if (!isTrustedSender(event)) {
        throw new Error("ipc: untrusted sender");
      }
      return await runValidated(validate, rawArgs, handler);
    } catch (error) {
      console.error(`[ipc:${channel}]`, error);
      throw error;
    }
  });
};
