import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { projectHeadProps, type BrandColorMap } from "@shared/brand";
import type { MonitorChange } from "@shared/monitor";

/** 載入各專案 README 的品牌主色；元件掛載時讀一次，失敗就當作沒有品牌色，畫面維持原樣。 */
export const useBrandColors = (): BrandColorMap => {
  const [colors, setColors] = useState<BrandColorMap>({});

  useEffect(() => {
    let active = true;
    void window.gitNRun
      .getBrandColors()
      .then((next) => {
        if (active) setColors(next);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  return colors;
};

export interface ProjectHeadAttrs {
  className: string;
  style?: CSSProperties;
}

/** 專案名稱列（.project-head）的屬性：路徑所屬專案有品牌色就帶上色條樣式，沒有就維持原本的樣子。 */
export const useProjectHead = (): ((path: string | null | undefined) => ProjectHeadAttrs) => {
  const colors = useBrandColors();
  return useCallback(
    (path) => {
      const { className, style } = projectHeadProps(colors, path);
      return style === undefined ? { className } : { className, style: style as CSSProperties };
    },
    [colors]
  );
};

/** 訂閱主程序的「有新事件／狀態變動」通知；handler 用 ref 保存，不會因為重新渲染而重新訂閱。 */
export const useMonitorChanged = (handler: (change: MonitorChange) => void): void => {
  const latest = useRef(handler);
  latest.current = handler;

  useEffect(() => window.gitNRun.onMonitorChanged((change) => latest.current(change)), []);
};

/** 輸入值停止變動一段時間後才更新，避免每個按鍵都打一次查詢。 */
export const useDebounced = <T>(value: T, delayMs: number): T => {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
};
