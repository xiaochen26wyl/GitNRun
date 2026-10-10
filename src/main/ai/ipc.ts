import { clipboard } from "electron";
import { IPC } from "@shared/ipc";
import type { AiService } from "@main/ai/service";
import { handleIpc } from "@main/ipc";
import { asClipboardArgs, asConflictArgs, asIdArgs, asNoArgs, asRuleObjectArgs } from "@main/ipc-validation";

export const registerAiIpc = (ai: AiService): void => {
  handleIpc(IPC.aiSettingsGet, asNoArgs, () => ai.getSettings());
  // 設定內容的細部驗證與錯誤訊息由服務負責（要回報給使用者），這裡只確認形狀。
  handleIpc(IPC.aiSettingsSave, asRuleObjectArgs, (raw) => ai.saveSettings(raw));
  handleIpc(IPC.aiUsage, asNoArgs, () => ai.usage());
  handleIpc(IPC.aiPreviewCommit, asIdArgs, (projectId) => ai.previewCommitMessage(projectId));
  handleIpc(IPC.aiCommitMessage, asIdArgs, (projectId) => ai.generateCommitMessage(projectId));
  handleIpc(IPC.aiSummarizeEvent, asIdArgs, (eventId) => ai.summarizeEvent(eventId));
  handleIpc(IPC.aiSuggestEvent, asIdArgs, (eventId) => ai.suggestForEvent(eventId));
  handleIpc(IPC.aiConflicts, asConflictArgs, (projectId, against) => ai.predictConflicts(projectId, against));
  handleIpc(IPC.clipboardWrite, asClipboardArgs, (text) => {
    clipboard.writeText(text);
  });
};
