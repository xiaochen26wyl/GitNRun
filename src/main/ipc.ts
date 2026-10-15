import type { IpcChannel } from "@shared/ipc";
import { runValidated, type ArgsValidator } from "@main/ipc-validation";

/**
 * 全 app 唯一註冊 IPC handler 的入口：通道必須在 shared/ipc 宣告過，
 * 呼叫時先驗證入參，通過後才進到 handler。
 *
 * 這裡只管「通道 → 驗證 → handler」，與外殼無關；發送端是否可信、怎麼把呼叫送進來
 * （Electron 的 ipcMain、Tauri 的 sidecar 連線）由各外殼的轉接層負責，並且必須先擋掉不可信的發送端。
 */

type ChannelHandler = (rawArgs: readonly unknown[]) => Promise<unknown>;

const registry = new Map<string, ChannelHandler>();

export const handleIpc = <A extends unknown[], R>(
  channel: IpcChannel,
  validate: ArgsValidator<A>,
  handler: (...args: A) => R | Promise<R>
): void => {
  if (registry.has(channel)) {
    throw new Error(`ipc: channel registered twice: ${channel}`);
  }
  registry.set(channel, (rawArgs) => runValidated(validate, rawArgs, handler));
};

export const registeredChannels = (): string[] => [...registry.keys()];

/** 執行一次呼叫；未註冊的通道一律拒絕（fail-closed）。 */
export const invokeChannel = async (channel: string, rawArgs: readonly unknown[]): Promise<unknown> => {
  const handler = registry.get(channel);
  if (!handler) {
    throw new Error("ipc: unknown channel");
  }
  try {
    return await handler(rawArgs);
  } catch (error) {
    console.error(`[ipc:${channel}]`, error);
    throw error;
  }
};

/** 測試用：清空註冊表。 */
export const resetIpcRegistry = (): void => {
  registry.clear();
};
