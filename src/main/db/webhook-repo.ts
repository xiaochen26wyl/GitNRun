import type { Db } from "@main/db/database";

/** 記下這次送達；已經處理過就回傳 false（GitHub 重送同一個 delivery）。 */
export const recordDelivery = (db: Db, deliveryId: string, projectId: number, now: number): boolean =>
  Number(db.prepare("INSERT OR IGNORE INTO webhook_deliveries (delivery_id, project_id, received_at) VALUES (?, ?, ?)").run(deliveryId, projectId, now).changes) > 0;

/** 產生或輪替 secret 時建立／更新這個專案的 webhook 設定列。 */
export const upsertWebhookRow = (db: Db, projectId: number, secretRef: string, now: number): void => {
  db.prepare(
    `INSERT INTO webhooks (project_id, enabled, secret_ref, created_at) VALUES (?, 1, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET secret_ref = excluded.secret_ref, enabled = 1`
  ).run(projectId, secretRef, now);
};

export const touchWebhook = (db: Db, projectId: number, now: number): void => {
  db.prepare("UPDATE webhooks SET last_received_at = ? WHERE project_id = ?").run(now, projectId);
};

export const getLastReceivedAt = (db: Db, projectId: number): number | null => {
  const row = db.prepare("SELECT last_received_at FROM webhooks WHERE project_id = ?").get(projectId);
  return row?.last_received_at === null || row?.last_received_at === undefined ? null : Number(row.last_received_at);
};

/**
 * 輪詢可能比 Webhook 早一步記下同一次推送（推送者只是推定）。Webhook 帶來確切的推送者時，
 * 把推定的換成確切的；已經是確切的就不動。
 */
export const upgradePusher = (db: Db, eventId: number, pusher: string): boolean =>
  Number(db.prepare("UPDATE push_events SET pusher = ?, pusher_inferred = 0 WHERE id = ? AND pusher_inferred = 1").run(pusher, eventId).changes) > 0;
