import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AppSettingsPatch } from "@shared/app-settings";

/** 排序與頁籤名稱的舊存放位置（localStorage 以網址分區，Dev 的 port 一變就讀不到）；只在第一次把舊資料搬進資料庫時讀。 */
const LEGACY_ORDER_KEY = "gitnrun.run.order";
const LEGACY_SORT_MODE_KEY = "gitnrun.run.sortMode";

interface ViewPrefs {
  runOrder: string | null;
  runSortModes: string | null;
  tabNames: Record<string, string>;
  save: (patch: Pick<AppSettingsPatch, "runOrder" | "runSortModes" | "tabNames">) => void;
}

const ViewPrefsContext = createContext<ViewPrefs | null>(null);

const legacy = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

/** 檢視偏好（手動排序、排序模式、頁籤名稱）存在核心資料庫，Dev 重啟、換 port 都不會遺失。載入前用預設值。 */
export const ViewPrefsProvider = ({ children }: { children: ReactNode }) => {
  const [prefs, setPrefs] = useState<Omit<ViewPrefs, "save">>({ runOrder: null, runSortModes: null, tabNames: {} });

  useEffect(() => {
    void window.gitNRun
      .getAppSettings()
      .then((settings) => {
        const runOrder = settings.runOrder ?? legacy(LEGACY_ORDER_KEY);
        const runSortModes = settings.runSortModes ?? legacy(LEGACY_SORT_MODE_KEY);
        setPrefs({ runOrder, runSortModes, tabNames: settings.tabNames });
        const migrate: AppSettingsPatch = {
          ...(settings.runOrder === null && runOrder !== null ? { runOrder } : {}),
          ...(settings.runSortModes === null && runSortModes !== null ? { runSortModes } : {})
        };
        if (Object.keys(migrate).length > 0) void window.gitNRun.saveAppSettings(migrate).catch(() => undefined);
      })
      .catch(() => undefined);
  }, []);

  const save = useCallback<ViewPrefs["save"]>((patch) => {
    setPrefs((current) => ({ ...current, ...patch }));
    void window.gitNRun
      .saveAppSettings(patch)
      .then((settings) => setPrefs({ runOrder: settings.runOrder, runSortModes: settings.runSortModes, tabNames: settings.tabNames }))
      .catch(() => undefined);
  }, []);

  const value = useMemo(() => ({ ...prefs, save }), [prefs, save]);
  return <ViewPrefsContext.Provider value={value}>{children}</ViewPrefsContext.Provider>;
};

export const useViewPrefs = (): ViewPrefs => {
  const value = useContext(ViewPrefsContext);
  if (value === null) throw new Error("ViewPrefsProvider is missing");
  return value;
};
