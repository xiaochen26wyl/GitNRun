import { OFFLINE_REASON_TEXT, type AiResult } from "@shared/ai";
import type { AiService } from "@main/ai/service";
import { UserFacingError } from "@main/errors";
import type { ActionExecutors, ActionResult } from "@main/rules/engine";

/**
 * AI 動作：產生 commit 訊息、摘要推送內容。結果存成這次規則執行的輸出變數
 * （ai_commit_message、ai_summary），後面的動作可以在通知文字用 {ai_summary}、
 * 在 shell 用 PW_AI_SUMMARY、在 git commit 的參數用 {ai_commit_message}。
 *
 * 這兩個動作預設自動執行（不需要逐次確認）：是否允許把專案內容送給 AI，由「專案層級的開關」決定，
 * 沒開的專案只會得到本機規則的結果。
 */

const SOURCE_LABEL = { ai: "AI", cache: "AI（快取）", offline: "本機規則" } as const;

const describeResult = (result: AiResult): string => {
  const via = result.source === "offline" && result.reason ? `${SOURCE_LABEL.offline}：${OFFLINE_REASON_TEXT[result.reason]}` : SOURCE_LABEL[result.source];
  return `${via}`;
};

const fromResult = (name: "ai_commit_message" | "ai_summary", result: AiResult): ActionResult => {
  // 沒有任何文字（沒有可提交的變更、讀 git 失敗）就是失敗，不要產生空的輸出。
  if (result.text.trim() === "") {
    return { status: "failed", message: result.reason ? OFFLINE_REASON_TEXT[result.reason] : "沒有產生內容" };
  }
  return {
    status: "success",
    message: `${describeResult(result)}：${result.text.split("\n", 1)[0]?.slice(0, 120) ?? ""}`,
    output: { name, value: result.text }
  };
};

const userMessage = (error: unknown): ActionResult => ({
  status: "failed",
  message: error instanceof UserFacingError ? error.message : "AI 動作執行時發生未預期的錯誤"
});

export const createAiExecutors = (ai: Pick<AiService, "generateCommitMessage" | "summarizeEventBatched">): Pick<ActionExecutors, "ai_commit_message" | "ai_summary"> => ({
  ai_commit_message: {
    describe: (_action, { project }) =>
      project.aiEnabled
        ? `請 AI 根據 ${project.localPath ?? "（未設定路徑）"} 尚未提交的變更產生 commit 訊息（排除清單上的檔案不送、疑似密鑰會遮蔽）`
        : "這個專案尚未允許 AI 分析，會改用本機規則產生 commit 訊息",
    async run(_action, { project }) {
      try {
        return fromResult("ai_commit_message", await ai.generateCommitMessage(project.id));
      } catch (error) {
        return userMessage(error);
      }
    }
  },

  ai_summary: {
    describe: (_action, { project }) =>
      project.aiEnabled ? "請 AI 摘要這次推送（只送 commit 訊息與檔名，不送程式碼）" : "這個專案尚未允許 AI 分析，會改用本機規則產生摘要",
    async run(_action, { event }) {
      try {
        return fromResult("ai_summary", await ai.summarizeEventBatched(event.id));
      } catch (error) {
        return userMessage(error);
      }
    }
  }
});
