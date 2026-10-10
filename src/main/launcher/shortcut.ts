import { isValidAccelerator } from "@shared/launcher";

/**
 * 全域快捷鍵的註冊管理。Electron 的 globalShortcut 由外部注入，所以註冊／衝突／切換的邏輯可以直接測試。
 */

export interface ShortcutApi {
  /** 成功回傳 true；被其他程式佔用或格式不被接受時回傳 false（或丟出例外）。 */
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

export interface ShortcutManager {
  /** 目前實際註冊中的快捷鍵；沒有則為 null。 */
  current(): string | null;
  /**
   * 換成新的快捷鍵（null = 停用）。失敗時保留原本的註冊並回傳 false，
   * 不會出現「舊的取消了、新的又沒成功」而完全沒有快捷鍵的狀態。
   */
  apply(accelerator: string | null): boolean;
  dispose(): void;
}

export const createShortcutManager = (api: ShortcutApi, onTrigger: () => void): ShortcutManager => {
  let registered: string | null = null;

  const tryRegister = (accelerator: string): boolean => {
    try {
      return api.register(accelerator, onTrigger);
    } catch {
      return false;
    }
  };

  return {
    current: () => registered,

    apply(accelerator) {
      if (accelerator === registered) {
        return true;
      }
      if (accelerator === null) {
        if (registered !== null) {
          api.unregister(registered);
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
        api.unregister(previous);
      }
      if (tryRegister(accelerator)) {
        registered = accelerator;
        return true;
      }
      registered = previous !== null && tryRegister(previous) ? previous : null;
      return false;
    },

    dispose() {
      if (registered !== null) {
        api.unregister(registered);
        registered = null;
      }
    }
  };
};
