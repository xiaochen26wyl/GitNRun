import { matchesAnyGlob } from "@shared/glob";
import type { Project } from "@shared/projects";
import { WEBHOOK_PATH_PREFIX } from "@shared/webhook";
import type { Db } from "@main/db/database";
import { getProject } from "@main/db/projects-repo";
import { recordDelivery, touchWebhook, upgradePusher } from "@main/db/webhook-repo";
import type { LogEntry } from "@main/logger";
import type { IngestFn } from "@main/monitor/ingest";
import { parsePushPayload } from "@main/webhook/payload";
import { verifySignature } from "@main/webhook/verify";

/**
 * 收到 GitHub Webhook 的處理流程。收一個純資料的請求、回一個狀態碼，所以不開任何連接埠就能測試。
 *
 * 順序刻意如此：先確認這個專案存在且啟用 Webhook、內容類型與大小合理 → 驗證簽章（缺少或錯誤一律 403）→
 * 之後才信任任何內容：去重、解析、核對 repo 是否相符。簽章通過之前，不記錄、不解析、不處理任何東西。
 * 事件寫入走與輪詢相同的 ingestion pipeline（冪等），所以兩種來源並存也不會重複。
 */

export interface WebhookRequest {
  method: string;
  path: string;
  headers: Readonly<Record<string, string | undefined>>;
  body: Buffer;
}

export interface WebhookResponse {
  status: number;
  body: string;
  /** 背景處理完成時結算（伺服器不等它；測試用來等結果）。 */
  done?: Promise<void>;
}

export interface WebhookHandlerDeps {
  db: Db;
  now: () => number;
  /** 取得該專案的簽章 secret；沒設定回傳 null。明文只活在這次驗證的過程中。 */
  withSecret: <T>(projectId: number, fn: (secret: string) => T) => Promise<T | null>;
  ingest: IngestFn;
  log: (entry: LogEntry) => void;
  /** 有新事件或狀態變動，通知畫面更新。 */
  onActivity: (change: { events: boolean }) => void;
}

const DELIVERY_ID = /^[0-9A-Za-z-]{8,64}$/;
const UNAUTHENTICATED_LOG_INTERVAL_MS = 60_000;

const respond = (status: number, body: string, done?: Promise<void>): WebhookResponse => ({ status, body, ...(done ? { done } : {}) });

export const createWebhookHandler = (deps: WebhookHandlerDeps): ((request: WebhookRequest) => Promise<WebhookResponse>) => {
  const lastRejectLog = new Map<number, number>();

  const logRejected = (projectId: number): void => {
    const now = deps.now();
    if (now - (lastRejectLog.get(projectId) ?? 0) >= UNAUTHENTICATED_LOG_INTERVAL_MS) {
      lastRejectLog.set(projectId, now);
      deps.log({ category: "push", level: "warn", message: `拒絕了一個簽章驗證失敗的 Webhook 請求（專案 ${projectId}）` });
    }
  };

  const processPush = async (project: Project, payload: unknown): Promise<void> => {
    const parsed = parsePushPayload(payload);
    if (!parsed.ok) {
      return;
    }
    if (parsed.fullName.toLowerCase() !== `${project.owner}/${project.repo}`.toLowerCase()) {
      deps.log({ category: "push", level: "warn", message: `${project.name}：Webhook 內容的 repo（${parsed.fullName}）與專案不符，已忽略` });
      return;
    }
    if (!matchesAnyGlob(project.branchFilter, parsed.branch)) {
      return;
    }

    const result = await deps.ingest(project, { ...parsed.event, projectId: project.id, branchViolation: false, occurredAt: deps.now() });
    if (!result.inserted && parsed.event.pusher) {
      // 輪詢先一步記下了同一次推送：把推定的推送者換成 Webhook 帶來的確切推送者。
      upgradePusher(deps.db, result.id, parsed.event.pusher);
    }
    deps.onActivity({ events: result.inserted });
  };

  return async (request) => {
    if (request.method !== "POST") {
      return respond(405, "method not allowed");
    }
    const match = new RegExp(`^${WEBHOOK_PATH_PREFIX}(\\d{1,9})$`).exec(request.path);
    if (!match?.[1]) {
      return respond(404, "not found");
    }
    const project = getProject(deps.db, Number(match[1]));
    if (!project || !project.enabled || project.mode === "poll") {
      return respond(404, "not found");
    }

    if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      return respond(415, "content type must be application/json");
    }
    if (request.body.length === 0) {
      return respond(400, "empty body");
    }

    const verified = await deps.withSecret(project.id, (secret) =>
      verifySignature(secret, request.body, request.headers["x-hub-signature-256"])
    );
    if (verified !== true) {
      logRejected(project.id);
      return respond(403, "forbidden");
    }

    // ---- 以下才信任內容 ----
    const delivery = request.headers["x-github-delivery"] ?? "";
    if (!DELIVERY_ID.test(delivery)) {
      return respond(400, "missing or malformed delivery id");
    }
    if (!recordDelivery(deps.db, delivery, project.id, deps.now())) {
      return respond(200, "duplicate delivery");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(request.body.toString("utf8"));
    } catch {
      return respond(400, "invalid json");
    }

    const eventName = request.headers["x-github-event"];
    touchWebhook(deps.db, project.id, deps.now());

    if (eventName === "ping") {
      deps.log({ category: "push", level: "info", message: `${project.name}：收到 GitHub 的 Webhook ping，設定成功` });
      deps.onActivity({ events: false });
      return respond(200, "pong");
    }
    if (eventName !== "push") {
      return respond(200, "ignored");
    }

    // 先回應（GitHub 要求很快回覆），事件在背景處理。
    const done = processPush(project, payload).catch(() => {
      deps.log({ category: "push", level: "error", message: `${project.name}：處理 Webhook 事件時發生錯誤` });
    });
    return respond(202, "accepted", done);
  };
};
