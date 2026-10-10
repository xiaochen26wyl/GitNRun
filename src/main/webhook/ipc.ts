import { IPC } from "@shared/ipc";
import { handleIpc } from "@main/ipc";
import { asIdArgs, asNoArgs, asRuleObjectArgs } from "@main/ipc-validation";
import type { WebhookAdminHandlers } from "@main/webhook/handlers";

export const registerWebhookIpc = (handlers: WebhookAdminHandlers): void => {
  handleIpc(IPC.webhookSettingsGet, asNoArgs, () => handlers.getSettings());
  // 設定內容的細部驗證與錯誤訊息由處理器負責（要回報給使用者），這裡只確認形狀。
  handleIpc(IPC.webhookSettingsSave, asRuleObjectArgs, (raw) => handlers.saveSettings(raw));
  handleIpc(IPC.webhookStatus, asNoArgs, () => handlers.status());
  handleIpc(IPC.webhookProjects, asNoArgs, () => handlers.projects());
  handleIpc(IPC.webhookGenerateSecret, asIdArgs, (projectId) => handlers.generateSecret(projectId));
  handleIpc(IPC.webhookRemoveSecret, asIdArgs, (projectId) => handlers.removeSecret(projectId));
};
