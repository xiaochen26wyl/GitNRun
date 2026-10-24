import { randomBytes } from "node:crypto";
import { buildPayloadUrl, validateWebhookSettings, type ProjectWebhookInfo, type WebhookSettings, type WebhookStatus } from "@shared/webhook";
import type { Db } from "@main/db/database";
import { getProject, listProjects } from "@main/db/projects-repo";
import { setSetting } from "@main/db/settings-repo";
import { getLastReceivedAt, upsertWebhookRow } from "@main/db/webhook-repo";
import { UserFacingError } from "@main/errors";
import { VaultUnavailableError, type Vault } from "@main/vault/vault";
import { WEBHOOK_SETTINGS_KEY, readWebhookSettings, webhookSecretName, type WebhookReceiver } from "@main/webhook/receiver";

/** Webhook 的設定與 secret 管理（與外殼無關，可直接測試）。 */

export interface WebhookAdminDeps {
  db: Db;
  vault: Pick<Vault, "has" | "set" | "delete">;
  receiver: Pick<WebhookReceiver, "apply" | "status">;
  /** 把 secret 放進剪貼簿（並在一段時間後清除）。secret 不會經過畫面。 */
  copySecret: (secret: string) => void;
  newSecret?: () => string;
  now: () => number;
  onConfigChanged: () => void;
}

export interface WebhookAdminHandlers {
  getSettings(): WebhookSettings;
  saveSettings(raw: unknown): Promise<WebhookSettings>;
  status(): WebhookStatus;
  projects(): ProjectWebhookInfo[];
  generateSecret(projectId: number): { copied: true };
  removeSecret(projectId: number): void;
}

const SECRET_BYTES = 32;

export const createWebhookAdminHandlers = (deps: WebhookAdminDeps): WebhookAdminHandlers => {
  const { db } = deps;
  const newSecret = deps.newSecret ?? (() => randomBytes(SECRET_BYTES).toString("hex"));

  return {
    getSettings: () => readWebhookSettings(db),

    async saveSettings(raw) {
      const result = validateWebhookSettings(raw);
      if (!result.ok) {
        throw new UserFacingError(result.errors.join("\n"));
      }
      setSetting(db, WEBHOOK_SETTINGS_KEY, result.value);
      await deps.receiver.apply();
      deps.onConfigChanged();
      return result.value;
    },

    status: () => deps.receiver.status(),

    projects() {
      const { publicBaseUrl } = readWebhookSettings(db);
      return listProjects(db)
        .filter((project) => project.mode !== "poll")
        .map((project) => ({
          projectId: project.id,
          payloadUrl: buildPayloadUrl(publicBaseUrl, project.id),
          secretConfigured: deps.vault.has(webhookSecretName(project.id)),
          lastReceivedAt: getLastReceivedAt(db, project.id)
        }));
    },

    generateSecret(projectId) {
      if (!getProject(db, projectId)) {
        throw new UserFacingError("找不到這個專案");
      }
      const secret = newSecret();
      try {
        deps.vault.set(webhookSecretName(projectId), secret);
      } catch (error) {
        throw new UserFacingError(
          error instanceof VaultUnavailableError ? "此電腦無法使用系統金鑰保護，為了安全已拒絕儲存 secret" : "無法儲存 secret"
        );
      }
      upsertWebhookRow(db, projectId, webhookSecretName(projectId), deps.now());
      // 只放進剪貼簿讓使用者貼到 GitHub；畫面與 IPC 都不會經手這個值。
      deps.copySecret(secret);
      deps.onConfigChanged();
      return { copied: true };
    },

    removeSecret(projectId) {
      deps.vault.delete(webhookSecretName(projectId));
      deps.onConfigChanged();
    }
  };
};
