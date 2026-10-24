import type { RunOverview } from "./run";

const KEY = "gitnrun.runOverview";

type Store = Pick<Storage, "getItem" | "setItem">;

const defaultStore = (): Store | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

/** 讀上次成功的專案概況；沒有、壞掉或讀不到都回 null（畫面退回「載入中」）。 */
export const readOverviewCache = (store: Store | null = defaultStore()): RunOverview | null => {
  try {
    const raw = store?.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const targets = (parsed as { targets?: unknown } | null)?.targets;
    return Array.isArray(targets) ? (parsed as RunOverview) : null;
  } catch {
    return null;
  }
};

export const writeOverviewCache = (overview: RunOverview, store: Store | null = defaultStore()): void => {
  try {
    store?.setItem(KEY, JSON.stringify(overview));
  } catch {
    // 寫不進去只是少了快取。
  }
};
