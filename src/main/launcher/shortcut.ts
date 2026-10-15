import { isValidAccelerator } from "@shared/launcher";

/**
 * 全域快捷鍵的註冊管理。外殼的快捷鍵 API 由外部注入，所以註冊／衝突／切換的邏輯可以直接測試。
 * 外殼的註冊可能要跨行程往返，所以介面是非同步的；apply／dispose 會排成一條佇列依序執行，
 * 連續呼叫也不會打亂「先放掉舊的、失敗再還原」的順序。
 */

export interface ShortcutApi {
  /** 成功回傳 true；被其他程式佔用或格式不被接受時回傳 false（或丟出例外）。 */
  register(accelerator: string, callback: () => void): Promise<boolean>;
  unregister(accelerator: string): Promise<void>;
}

export interface ShortcutManager {
  /** 目前實際註冊中的快捷鍵；沒有則為 null。 */
  current(): string | null;
  /**
   * 換成新的快捷鍵（null = 停用）。失敗時保留原本的註冊並回傳 false，
   * 不會出現「舊的取消了、新的又沒成功」而完全沒有快捷鍵的狀態。
   */
  apply(accelerator: string | null): Promise<boolean>;
  dispose(): Promise<void>;
}

export const createShortcutManager = (api: ShortcutApi, onTrigger: () => void): ShortcutManager => {
  let registered: string | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task, task);
    queue = result.catch(() => undefined);
    return result;
  };

  const tryRegister = async (accelerator: string): Promise<boolean> => {
    try {
      return await api.register(accelerator, onTrigger);
    } catch {
      return false;
    }
  };

  const applyNow = async (accelerator: string | null): Promise<boolean> => {
    if (accelerator === registered) {
      return true;
    }
    if (accelerator === null) {
      if (registered !== null) {
        await api.unregister(registered);
      }
      registered = null;
      return true;
    }
    if (!isValidAccelerator(accelerator)) {
      return false;
    }

    // 先放掉舊的才有機會註冊新的（可能只是大小寫不同的同一組鍵）；失敗再還原。
    const previous = registered;
    if (previous !== null) {
      await api.unregister(previous);
    }
    if (await tryRegister(accelerator)) {
      registered = accelerator;
      return true;
    }
    registered = previous !== null && (await tryRegister(previous)) ? previous : null;
    return false;
  };

  return {
    current: () => registered,

    apply: (accelerator) => serialize(() => applyNow(accelerator)),

    dispose: () =>
      serialize(async () => {
        if (registered !== null) {
          const target = registered;
          registered = null;
          await api.unregister(target);
        }
      })
  };
};
