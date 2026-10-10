import { useEffect, useRef, useState } from "react";
import type { MonitorChange } from "@shared/monitor";

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
