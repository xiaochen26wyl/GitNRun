/**
 * 核心（sidecar）上線後要不要重載頁面。
 * 頁面可能在核心就緒前就載入（冷啟動要等 Keychain 授權、核心因程式變更或當掉而重啟），
 * 那時畫面上的資料是空的或是錯誤；核心就緒後重載一次才會重新取資料。
 * 兩次重載之間至少隔一段時間，核心反覆上下線時不會讓頁面一直閃。
 */

export const MIN_RELOAD_INTERVAL_MS = 5000;

export interface ReloadPolicy {
  /** 有呼叫因核心不可用而失敗。 */
  markUnavailable(): void;
  /** 核心上線／離線事件；回傳 true 表示現在要重載頁面。 */
  onSidecarEvent(online: boolean, now: number): boolean;
}

export const isUnavailableError = (reason: unknown): boolean =>
  typeof reason === "object" && reason !== null && (reason as { name?: unknown }).name === "SidecarUnavailable";

export const createReloadPolicy = (lastReloadAt: number | null = null): ReloadPolicy => {
  let stale = false;
  let last = lastReloadAt;
  return {
    markUnavailable() {
      stale = true;
    },
    onSidecarEvent(online, now) {
      if (!online) {
        stale = true;
        return false;
      }
      if (!stale) return false;
      if (last !== null && now - last < MIN_RELOAD_INTERVAL_MS) return false;
      last = now;
      stale = false;
      return true;
    }
  };
};
