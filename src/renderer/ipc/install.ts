import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createGitNRunApi, type ShimTransport } from "./create-api";
import { createShellReadySignal } from "@shared/shell-ready";
import { createReloadPolicy, isUnavailableError } from "./reload-policy";

/** Rust 在核心連線上線／離線時送的事件。 */
export const SIDECAR_EVENT = "gitnrun:sidecar";

const RELOAD_KEY = "gitnrun.lastReloadAt";

const readLastReload = (): number | null => {
  try {
    const value = Number(window.sessionStorage.getItem(RELOAD_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
};

const reloadPolicy = createReloadPolicy(typeof window === "undefined" ? null : readLastReload());

const tauriTransport: ShimTransport = {
  invoke: (command, args) =>
    invoke(command, args).catch((reason: unknown) => {
      if (isUnavailableError(reason)) reloadPolicy.markUnavailable();
      throw reason;
    }),
  listen: (event, handler) => listen(event, (message) => handler(message.payload))
};

/** 只有在 Tauri 的頁面裡才有 __TAURI_INTERNALS__。 */
const insideTauri = (): boolean => "__TAURI_INTERNALS__" in window;

/**
 * 安裝 window.gitNRun。已經有或不在 Tauri 裡就什麼都不做，
 * 所以同一份 renderer 兩種外殼共用。
 */
export const installTauriShim = (): void => {
  // 不用 `in`：型別上 window 一定有 gitNRun，`in` 會把後面的 window 收窄成 never。
  if (Object.hasOwn(window, "gitNRun") || !insideTauri()) {
    return;
  }

  const { api } = createGitNRunApi(tauriTransport);
  Object.defineProperty(window, "gitNRun", { value: api, writable: false, configurable: false });

  // 沿用既有行為：不顯示瀏覽器右鍵選單；也不處理檔案拖放（拿不到路徑，也避免整頁被導走）。
  window.addEventListener("contextmenu", (event) => event.preventDefault());
  for (const name of ["dragover", "drop"] as const) {
    window.addEventListener(name, (event) => event.preventDefault());
  }

  // 核心晚於頁面就緒（冷啟動等 Keychain 授權）或重啟過：上線後重載一次，重新取資料。
  void listen<{ online?: boolean }>(SIDECAR_EVENT, (message) => {
    const now = Date.now();
    if (reloadPolicy.onSidecarEvent(message.payload?.online === true, now)) {
      try {
        window.sessionStorage.setItem(RELOAD_KEY, String(now));
      } catch {
        // 沒有 sessionStorage 也只是少了「間隔」保護。
      }
      window.location.reload();
    }
  });
};

/** 外殼首次繪製後呼叫；不在 Tauri 裡（瀏覽器預覽）什麼都不做。 */
export const signalShellReady = createShellReadySignal((channel) =>
  insideTauri() ? invoke("ipc_invoke", { channel, args: [] }) : Promise.resolve()
);
