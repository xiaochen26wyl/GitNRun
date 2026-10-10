import { DEFAULT_WEBHOOK_SETTINGS, validateWebhookSettings, type WebhookSettings, type WebhookStatus } from "@shared/webhook";
import type { Db } from "@main/db/database";
import { getSetting } from "@main/db/settings-repo";
import type { LogEntry } from "@main/logger";
import type { IngestFn } from "@main/monitor/ingest";
import { createWebhookHandler } from "@main/webhook/handler";
import { createWebhookServer, type WebhookServer } from "@main/webhook/server";
import type { Vault } from "@main/vault/vault";
import { SecretUnreadableError } from "@main/vault/vault";

export const WEBHOOK_SETTINGS_KEY = "webhook.settings";

export const webhookSecretName = (projectId: number): string => `webhook.secret.${projectId}`;

/** 讀設定時一律重新驗證；被改壞的值退回預設（預設是關閉）。 */
export const readWebhookSettings = (db: Db): WebhookSettings => {
  const stored = getSetting<unknown>(db, WEBHOOK_SETTINGS_KEY, null);
  if (stored === null) return DEFAULT_WEBHOOK_SETTINGS;
  const result = validateWebhookSettings(stored);
  return result.ok ? result.value : DEFAULT_WEBHOOK_SETTINGS;
};

export interface WebhookReceiverDeps {
  db: Db;
  vault: Pick<Vault, "has" | "useSecret">;
  ingest: IngestFn;
  log: (entry: LogEntry) => void;
  now: () => number;
  onActivity: (change: { events: boolean }) => void;
  /** 測試用：換成假的伺服器。 */
  server?: WebhookServer;
}

export interface WebhookReceiver {
  /** 依目前的設定啟動或關閉接收端。 */
  apply(): Promise<void>;
  status(): WebhookStatus;
  stop(): Promise<void>;
}

export const createWebhookReceiver = (deps: WebhookReceiverDeps): WebhookReceiver => {
  const handler = createWebhookHandler({
    db: deps.db,
    now: deps.now,
    ingest: deps.ingest,
    log: deps.log,
    onActivity: deps.onActivity,
    withSecret: async (projectId, fn) => {
      const name = webhookSecretName(projectId);
      if (!deps.vault.has(name)) return null;
      try {
        return await deps.vault.useSecret(name, fn);
      } catch (error) {
        if (error instanceof SecretUnreadableError) return null;
        throw error;
      }
    }
  });
  const server = deps.server ?? createWebhookServer(handler);

  return {
    async apply() {
      const settings = readWebhookSettings(deps.db);
      if (!settings.enabled) {
        await server.stop();
        return;
      }
      await server.start(settings.port);
      const status = server.status();
      deps.log({
        category: "system",
        level: status.listening ? "info" : "warn",
        message: status.listening ? `Webhook 接收端已在 127.0.0.1:${status.port} 啟動` : `Webhook 接收端無法啟動：${status.error ?? "未知原因"}`
      });
    },

    status() {
      const settings = readWebhookSettings(deps.db);
      const server_ = server.status();
      return { enabled: settings.enabled, listening: server_.listening, port: settings.port, error: settings.enabled ? server_.error : null };
    },

    stop: () => server.stop()
  };
};
