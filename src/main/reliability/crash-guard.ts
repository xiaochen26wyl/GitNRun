import { readFileSync, writeFileSync } from "node:fs";

/**
 * 崩潰迴圈保護：短時間內重啟太多次就不再重啟，改成通知使用者。
 *
 * 重啟紀錄要存檔——重啟之後整個行程都換新的，只放記憶體等於每次都從零開始算，保護就失效了。
 */

export interface CrashGuardOptions {
  maxRestarts: number;
  windowMs: number;
  now: () => number;
  load: () => number[];
  save: (times: number[]) => void;
}

export interface CrashGuard {
  /** 允許就記下這次重啟並回傳 true；窗口內已達上限回傳 false（不記錄）。 */
  allowRestart(): boolean;
  reset(): void;
}

export const createCrashGuard = (options: CrashGuardOptions): CrashGuard => ({
  allowRestart() {
    const now = options.now();
    // 時間往回跳（調整系統時間）的紀錄一併丟掉，免得永遠被擋住。
    const recent = options.load().filter((time) => time <= now && now - time < options.windowMs);
    if (recent.length >= options.maxRestarts) {
      options.save(recent);
      return false;
    }
    options.save([...recent, now]);
    return true;
  },

  reset() {
    options.save([]);
  }
});

/** 以檔案保存重啟紀錄；檔案不存在或壞掉就當作沒有紀錄。 */
export const fileBackedRestartLog = (path: string): Pick<CrashGuardOptions, "load" | "save"> => ({
  load() {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      return Array.isArray(parsed) ? parsed.filter((item): item is number => typeof item === "number" && Number.isFinite(item)) : [];
    } catch {
      return [];
    }
  },
  save(times) {
    try {
      writeFileSync(path, JSON.stringify(times), { mode: 0o600 });
    } catch {
      // 寫不進去就算了：最壞的情況是保護比較寬鬆，不能因此讓程式更不穩。
    }
  }
});

/** 記憶體版（視窗重新載入的頻率限制這類不需要跨重啟的場合）。 */
export const inMemoryRestartLog = (): Pick<CrashGuardOptions, "load" | "save"> => {
  let times: number[] = [];
  return { load: () => times, save: (next) => void (times = next) };
};

export interface FaultTracker {
  /** 記錄一次未捕捉的錯誤；窗口內累積到門檻就回傳 true（視為致命，需要重啟）。 */
  record(): boolean;
}

/** 偶發的未捕捉錯誤只記錄，不退出；短時間內大量出現才視為真的壞掉了。 */
export const createFaultTracker = (options: { threshold: number; windowMs: number; now: () => number }): FaultTracker => {
  let times: number[] = [];
  return {
    record() {
      const now = options.now();
      times = [...times.filter((time) => now - time < options.windowMs), now];
      return times.length >= options.threshold;
    }
  };
};
