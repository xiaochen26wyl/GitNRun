import type { ConfirmDecision, ConfirmRequest } from "@shared/rule-runs";
import { native } from "@main/native/bridge";
import { formatConfirmText } from "@main/rules/confirm-text";

export const CONFIRM_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * 寫入型動作的確認：用主程序的原生對話框，渲染層無法偽造按下「允許」。
 * 預設按鈕是「拒絕」；逾時未回應視為跳過（timeout），由引擎記錄。
 */
export const showConfirmDialog = async (request: ConfirmRequest, timeoutMs: number = CONFIRM_TIMEOUT_MS): Promise<ConfirmDecision> => {
  const { message, detail } = formatConfirmText(request);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  native().bounceDock();

  try {
    const response = await native().confirm(
      {
        kind: "warning",
        title: "GitNRun",
        message,
        detail,
        buttons: ["拒絕", "允許這一次"],
        defaultId: 0,
        cancelId: 0
      },
      { signal: controller.signal }
    );
    if (controller.signal.aborted) {
      return "timeout";
    }
    return response === 1 ? "allow" : "deny";
  } finally {
    clearTimeout(timer);
  }
};
