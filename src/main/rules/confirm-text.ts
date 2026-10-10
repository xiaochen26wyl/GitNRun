import { ACTION_LABELS, type ActionType } from "@shared/rules";
import type { ConfirmRequest } from "@shared/rule-runs";

/** 確認視窗的文字（純函式）。 */

export interface ConfirmDialogText {
  message: string;
  detail: string;
}

export const formatConfirmText = (request: ConfirmRequest): ConfirmDialogText => {
  const who = request.pusher ?? "（未知）";
  const label = ACTION_LABELS[request.actionType as ActionType] ?? request.actionType;
  return {
    message: `規則「${request.ruleName}」要執行：${label}`,
    detail: [
      "將執行的內容：",
      request.summary,
      "",
      `觸發來源：${request.projectName} 的 ${request.branch}`,
      `推送者：${who}`,
      `訊息：${request.headMessage || "（無）"}`,
      "",
      "推送內容來自遠端，只作為資料使用，不會被當成指令。確認上面的內容無誤再允許。"
    ].join("\n")
  };
};
