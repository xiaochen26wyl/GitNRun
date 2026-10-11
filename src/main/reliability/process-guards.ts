import { join } from "node:path";
import { app, dialog } from "electron";
import { redact } from "@main/log-redaction";
import type { Logger } from "@main/logger";
import { createCrashGuard, createFaultTracker, fileBackedRestartLog } from "@main/reliability/crash-guard";

/**
 * 行程層級的錯誤保護。
 *
 * - 偶發的未捕捉例外／Promise 拒絕只記錄、不退出（監視器與規則引擎不該因為一個意外就停擺）。
 * - 短時間內大量出現才視為真的壞了：重啟一次。
 * - 重啟太頻繁（崩潰迴圈）就不再重啟，改成告訴使用者，避免無限循環。
 */

const FAULT_THRESHOLD = 5;
const FAULT_WINDOW_MS = 60_000;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 5 * 60_000;

export const installProcessGuards = (options: { getLogger: () => Logger | null }): void => {
  const guard = createCrashGuard({
    maxRestarts: MAX_RESTARTS,
    windowMs: RESTART_WINDOW_MS,
    now: Date.now,
    ...fileBackedRestartLog(join(app.getPath("userData"), "restarts.json"))
  });
  const faults = createFaultTracker({ threshold: FAULT_THRESHOLD, windowMs: FAULT_WINDOW_MS, now: Date.now });

  const report = (message: string): void => {
    const logger = options.getLogger();
    if (logger) {
      logger.log({ category: "system", level: "error", message });
    } else {
      console.error(`[gitnrun] ${message}`);
    }
  };

  const fatal = (): void => {
    if (guard.allowRestart()) {
      report("短時間內發生太多錯誤，重新啟動 devRun");
      app.relaunch();
      app.exit(0);
      return;
    }
    dialog.showErrorBox("devRun 無法穩定執行", "短時間內已經重新啟動多次仍然發生錯誤，為了避免無限重啟，這次不再自動重啟。請到日誌查看原因，或重新開啟 App。");
    app.exit(1);
  };

  const onFault = (kind: string, error: unknown): void => {
    report(`未捕捉的${kind}：${redact(error)}`);
    if (faults.record()) {
      fatal();
    }
  };

  process.on("uncaughtException", (error) => onFault("例外", error));
  process.on("unhandledRejection", (reason) => onFault("Promise 拒絕", reason));
  app.on("child-process-gone", (_event, details) => {
    report(`子行程異常結束：${details.type}（${details.reason}）`);
  });
};
