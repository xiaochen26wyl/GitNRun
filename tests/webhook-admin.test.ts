import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_WEBHOOK_SETTINGS, type WebhookSettings } from "@shared/webhook";
import { addProject } from "@main/db/projects-repo";
import { setSetting } from "@main/db/settings-repo";
import { touchWebhook } from "@main/db/webhook-repo";
import { UserFacingError } from "@main/errors";
import { createIngest } from "@main/monitor/ingest";
import { createWebhookAdminHandlers } from "@main/webhook/handlers";
import { WEBHOOK_SETTINGS_KEY, createWebhookReceiver, readWebhookSettings, webhookSecretName } from "@main/webhook/receiver";
import { computeSignature } from "@main/webhook/verify";
import { createWebhookHandler } from "@main/webhook/handler";
import type { WebhookServer } from "@main/webhook/server";
import { createVault } from "@main/vault/vault";
import { queryEvents } from "@main/db/events-repo";
import { createTestDb } from "./helpers/db";
import { createFakeCipher } from "./helpers/fake-cipher";

const fakeServer = () => {
  const calls: string[] = [];
  const state = { listening: false, port: 0, error: null as string | null };
  const server: WebhookServer = {
    start: async (port) => {
      calls.push(`start:${port}`);
      state.listening = state.error === null;
      state.port = port;
    },
    stop: async () => {
      calls.push("stop");
      state.listening = false;
    },
    status: () => ({ ...state })
  };
  return { server, calls, state };
};

const setup = (options: { cipherAvailable?: boolean } = {}) => {
  const db = createTestDb();
  const cipher = createFakeCipher();
  cipher.available = options.cipherAvailable ?? true;
  const vault = createVault(db, cipher);
  const fake = fakeServer();
  const logs: string[] = [];
  const receiver = createWebhookReceiver({
    db, vault, server: fake.server, now: () => 5,
    ingest: createIngest({ db }),
    log: (entry) => logs.push(entry.message),
    onActivity: () => undefined
  });
  const copied: string[] = [];
  let changed = 0;
  const handlers = createWebhookAdminHandlers({
    db, vault, receiver, now: () => 100,
    copySecret: (secret) => void copied.push(secret),
    onConfigChanged: () => void (changed += 1)
  });
  const project = (mode: "poll" | "webhook" | "both" = "webhook", repo = "api") =>
    addProject(db, { owner: "acme", repo, name: `acme/${repo}`, localPath: null, branchFilter: ["*"], pollIntervalSec: 30, mode, enabled: true, aiEnabled: false });
  return { db, vault, fake, receiver, handlers, copied, logs, project, changed: () => changed };
};

describe("webhook settings", () => {
  it("are off by default, and a corrupt stored value falls back to off", () => {
    const t = setup();
    assert.deepEqual(t.handlers.getSettings(), DEFAULT_WEBHOOK_SETTINGS);
    setSetting(t.db, WEBHOOK_SETTINGS_KEY, { enabled: true, port: 3 });
    assert.deepEqual(readWebhookSettings(t.db), DEFAULT_WEBHOOK_SETTINGS);
  });

  it("saving validates, persists, and starts or stops the receiver accordingly", async () => {
    const t = setup();
    const settings: WebhookSettings = { enabled: true, port: 9001, publicBaseUrl: "https://abc.ngrok-free.app" };

    assert.deepEqual(await t.handlers.saveSettings(settings), settings);
    assert.deepEqual(t.handlers.getSettings(), settings);
    assert.deepEqual(t.fake.calls, ["start:9001"]);
    assert.equal(t.handlers.status().listening, true);
    assert.ok(t.logs.some((message) => message.includes("127.0.0.1:9001")));

    await t.handlers.saveSettings({ ...settings, enabled: false });
    assert.equal(t.fake.calls.at(-1), "stop");
    assert.equal(t.handlers.status().listening, false);
    assert.ok(t.changed() >= 2);
  });

  it("rejects bad settings without touching the receiver", async () => {
    const t = setup();
    await assert.rejects(t.handlers.saveSettings({ enabled: true, port: 80 }), UserFacingError);
    await assert.rejects(t.handlers.saveSettings({ enabled: true, port: 9001, publicBaseUrl: "http://insecure.example.com" }), UserFacingError);
    assert.deepEqual(t.fake.calls, []);
    assert.deepEqual(t.handlers.getSettings(), DEFAULT_WEBHOOK_SETTINGS);
  });

  it("reports why the receiver could not start", async () => {
    const t = setup();
    t.fake.state.error = "連接埠已被其他程式使用";
    await t.handlers.saveSettings({ enabled: true, port: 9001, publicBaseUrl: null });
    assert.deepEqual(t.handlers.status(), { enabled: true, listening: false, port: 9001, error: "連接埠已被其他程式使用" });
    assert.ok(t.logs.some((message) => message.includes("無法啟動")));
  });

  it("a disabled receiver reports no error even if a previous attempt failed", async () => {
    const t = setup();
    t.fake.state.error = "stale";
    assert.equal(t.handlers.status().error, null);
  });
});

describe("per-project webhook info", () => {
  it("lists only projects that use webhooks, with their payload URL, secret state and last delivery", async () => {
    const t = setup();
    const hooked = t.project("webhook", "hooked");
    const both = t.project("both", "both");
    t.project("poll", "polled");
    await t.handlers.saveSettings({ enabled: true, port: 9001, publicBaseUrl: "https://abc.ngrok-free.app" });
    t.handlers.generateSecret(hooked.id);
    touchWebhook(t.db, hooked.id, 12345);

    const infos = t.handlers.projects();

    // 專案依名稱排序（both 在 hooked 之前）；mode 為 poll 的不會出現。
    assert.deepEqual(infos.map((info) => info.projectId), [both.id, hooked.id]);
    assert.deepEqual(infos[0], { projectId: both.id, payloadUrl: `https://abc.ngrok-free.app/hook/${both.id}`, secretConfigured: false, lastReceivedAt: null });
    assert.deepEqual(infos[1], { projectId: hooked.id, payloadUrl: `https://abc.ngrok-free.app/hook/${hooked.id}`, secretConfigured: true, lastReceivedAt: 12345 });
  });

  it("has no payload URL until a public address is configured", () => {
    const t = setup();
    t.project("webhook");
    assert.equal(t.handlers.projects()[0]?.payloadUrl, null);
  });
});

describe("generating a secret", () => {
  it("stores a strong random secret in the vault and puts it on the clipboard — it is never returned", () => {
    const t = setup();
    const project = t.project();

    const result = t.handlers.generateSecret(project.id);

    assert.deepEqual(result, { copied: true });
    assert.equal(t.copied.length, 1);
    assert.match(t.copied[0] as string, /^[0-9a-f]{64}$/);
    assert.equal(t.vault.has(webhookSecretName(project.id)), true);
    assert.ok(!JSON.stringify(result).includes(t.copied[0] as string));
    assert.equal(Number(t.db.prepare("SELECT COUNT(*) AS n FROM webhooks").get()?.n), 1);
  });

  it("every call makes a different secret, and regenerating replaces the old one", async () => {
    const t = setup();
    const project = t.project();
    t.handlers.generateSecret(project.id);
    t.handlers.generateSecret(project.id);
    assert.notEqual(t.copied[0], t.copied[1]);

    // 只有最新的 secret 能通過驗證。
    const logs: string[] = [];
    const handle = createWebhookHandler({
      db: t.db, now: () => 1, ingest: createIngest({ db: t.db }), log: (entry) => logs.push(entry.message), onActivity: () => undefined,
      withSecret: (projectId, fn) => t.vault.useSecret(webhookSecretName(projectId), fn)
    });
    const body = Buffer.from(JSON.stringify({ zen: "x" }));
    const send = (secret: string) =>
      handle({
        method: "POST", path: `/hook/${project.id}`, body,
        headers: { "content-type": "application/json", "x-github-event": "ping", "x-github-delivery": `d-${Math.random().toString(36).slice(2, 12)}`, "x-hub-signature-256": computeSignature(secret, body) }
      });
    assert.equal((await send(t.copied[0] as string)).status, 403, "the old secret no longer works");
    assert.equal((await send(t.copied[1] as string)).status, 200);
    assert.equal(queryEvents(t.db).events.length, 0);
  });

  it("refuses to store a secret when the system cannot protect it", () => {
    const t = setup({ cipherAvailable: false });
    const project = t.project();
    assert.throws(() => t.handlers.generateSecret(project.id), (error) => error instanceof UserFacingError && error.message.includes("拒絕儲存"));
    assert.deepEqual(t.copied, [], "nothing is copied when nothing was stored");
  });

  it("rejects an unknown project, and removing a secret really removes it", () => {
    const t = setup();
    assert.throws(() => t.handlers.generateSecret(999), UserFacingError);
    const project = t.project();
    t.handlers.generateSecret(project.id);
    t.handlers.removeSecret(project.id);
    assert.equal(t.vault.has(webhookSecretName(project.id)), false);
    assert.equal(t.handlers.projects()[0]?.secretConfigured, false);
  });
});
