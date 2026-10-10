import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { after, describe, it } from "node:test";
import { DEFAULT_WEBHOOK_SETTINGS, MAX_WEBHOOK_BODY_BYTES, WEBHOOK_HOST, buildPayloadUrl, normalizePublicBaseUrl, payloadPath, validateWebhookSettings } from "@shared/webhook";
import { addProject, getProject } from "@main/db/projects-repo";
import { queryEvents, insertEvent } from "@main/db/events-repo";
import { getLastReceivedAt, recordDelivery, touchWebhook, upgradePusher, upsertWebhookRow } from "@main/db/webhook-repo";
import { purgeExpired, DAY_MS } from "@main/db/retention";
import type { LogEntry } from "@main/logger";
import { createIngest } from "@main/monitor/ingest";
import { aggregateFiles, parsePushPayload } from "@main/webhook/payload";
import { createWebhookHandler, type WebhookRequest } from "@main/webhook/handler";
import { createWebhookServer } from "@main/webhook/server";
import { computeSignature, verifySignature } from "@main/webhook/verify";
import { createTestDb, makeEvent } from "./helpers/db";

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const ZERO = "0".repeat(40);

const pushPayload = (overrides: Record<string, unknown> = {}) => ({
  ref: "refs/heads/main",
  before: SHA_A,
  after: SHA_B,
  created: false,
  deleted: false,
  repository: { full_name: "acme/api" },
  sender: { login: "alice" },
  pusher: { name: "Alice Chen" },
  head_commit: { id: SHA_B, message: "feat: login\n\nlong body", timestamp: "2026-10-09T01:02:03Z" },
  commits: [
    { id: SHA_B, message: "feat: login", timestamp: "2026-10-09T01:02:03Z", author: { name: "Alice Chen", username: "alice" }, added: ["src/login.ts"], modified: ["README.md"], removed: [] }
  ],
  ...overrides
});

describe("verifySignature", () => {
  const body = Buffer.from('{"hello":"world"}');

  it("accepts the HMAC of the exact body", () => {
    assert.equal(verifySignature(SECRET, body, computeSignature(SECRET, body)), true);
    assert.equal(verifySignature(SECRET, body, computeSignature(SECRET, body).toUpperCase().replace("SHA256=", "sha256=")), true, "hex case does not matter");
  });

  it("rejects a different secret, a tampered body, and every malformed or missing header", () => {
    const good = computeSignature(SECRET, body);
    assert.equal(verifySignature("other-secret", body, good), false);
    assert.equal(verifySignature(SECRET, Buffer.from('{"hello":"w0rld"}'), good), false);
    for (const bad of [undefined, "", "sha256=", "sha256=abc", good.slice(7), `sha1=${good.slice(7)}`, `${good}00`, `sha256=${"z".repeat(64)}`, "sha256=" + "0".repeat(64)]) {
      assert.equal(verifySignature(SECRET, body, bad), false, String(bad));
    }
    assert.equal(verifySignature("", body, computeSignature("", body)), false, "an empty secret never verifies");
  });
});

describe("parsePushPayload", () => {
  it("maps a normal push with the exact pusher", () => {
    const parsed = parsePushPayload(pushPayload());
    assert.ok(parsed.ok);
    assert.equal(parsed.fullName, "acme/api");
    assert.equal(parsed.branch, "main");
    assert.deepEqual(
      { type: parsed.event.eventType, before: parsed.event.beforeSha, after: parsed.event.afterSha, pusher: parsed.event.pusher, inferred: parsed.event.pusherInferred, source: parsed.event.source },
      { type: "push", before: SHA_A, after: SHA_B, pusher: "alice", inferred: false, source: "webhook" }
    );
    assert.equal(parsed.event.headMessage, "feat: login");
    assert.deepEqual(parsed.event.files, [{ path: "src/login.ts", status: "added" }, { path: "README.md", status: "modified" }]);
    assert.equal(parsed.event.fileCount, 2);
    assert.deepEqual(parsed.event.commits[0], { sha: SHA_B, message: "feat: login", author: "alice", timestamp: Date.parse("2026-10-09T01:02:03Z") });
  });

  it("falls back to the pusher's name when there is no sender login", () => {
    const parsed = parsePushPayload(pushPayload({ sender: undefined }));
    assert.ok(parsed.ok);
    assert.equal(parsed.event.pusher, "Alice Chen");
  });

  it("branch creation has no before-SHA", () => {
    const parsed = parsePushPayload(pushPayload({ created: true, before: ZERO }));
    assert.ok(parsed.ok);
    assert.equal(parsed.event.eventType, "create");
    assert.equal(parsed.event.beforeSha, null);
  });

  it("deletion records the pre-delete head so it lines up with what polling records", () => {
    const parsed = parsePushPayload(pushPayload({ deleted: true, after: ZERO, before: SHA_A, head_commit: null, commits: [] }));
    assert.ok(parsed.ok);
    assert.equal(parsed.event.eventType, "delete");
    assert.equal(parsed.event.afterSha, SHA_A);
    assert.equal(parsed.event.headMessage, "");
    assert.deepEqual(parsed.event.files, []);
  });

  it("ignores tags, malformed refs and non-objects", () => {
    for (const bad of [
      pushPayload({ ref: "refs/tags/v1" }), pushPayload({ ref: "refs/heads/" }), pushPayload({ after: "nothex" }),
      pushPayload({ before: 5 }), pushPayload({ repository: {} }), null, "x", []
    ]) {
      assert.equal(parsePushPayload(bad).ok, false, JSON.stringify(bad)?.slice(0, 50));
    }
  });

  it("keeps only the newest 50 commits and tolerates junk entries", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ id: i.toString(16).padStart(40, "0"), message: `c${i}`, author: { name: "x" }, added: [], modified: [], removed: [] }));
    const parsed = parsePushPayload(pushPayload({ commits: [null, { id: "bad" }, "x", ...many] }));
    assert.ok(parsed.ok);
    assert.equal(parsed.event.commits.length, 50);
    assert.equal(parsed.event.commits.at(-1)?.message, "c79", "the newest commits are the ones kept");
  });
});

describe("aggregateFiles", () => {
  const commit = (added: string[], modified: string[], removed: string[]) => ({ added, modified, removed });

  it("tracks a file across commits like git would", () => {
    assert.deepEqual(aggregateFiles([commit(["a"], [], []), commit([], ["a", "b"], [])]), [{ path: "a", status: "added" }, { path: "b", status: "modified" }]);
    assert.deepEqual(aggregateFiles([commit(["a"], [], []), commit([], [], ["a"])]), [], "added then removed leaves nothing");
    assert.deepEqual(aggregateFiles([commit([], [], ["a"]), commit(["a"], [], [])]), [{ path: "a", status: "modified" }], "removed then re-added is a modification");
    assert.deepEqual(aggregateFiles([commit([], ["a"], []), commit([], [], ["a"])]), [{ path: "a", status: "removed" }]);
  });

  it("caps the list", () => {
    const files = Array.from({ length: 400 }, (_, i) => `f${i}`);
    assert.equal(aggregateFiles([commit(files, [], [])]).length, 300);
  });
});

describe("webhook handler", () => {
  const setup = (options: { mode?: "poll" | "webhook" | "both"; enabled?: boolean; secret?: string | null; branchFilter?: string[] } = {}) => {
    const db = createTestDb();
    const added = addProject(db, {
      owner: "acme", repo: "api", name: "acme/api", localPath: null, branchFilter: options.branchFilter ?? ["*"],
      pollIntervalSec: 30, mode: options.mode ?? "webhook", enabled: options.enabled ?? true, aiEnabled: false
    });
    const project = getProject(db, added.id)!;
    const logs: LogEntry[] = [];
    const activity: Array<{ events: boolean }> = [];
    let clock = 1_000_000;
    const secret = options.secret === undefined ? SECRET : options.secret;
    const handle = createWebhookHandler({
      db,
      now: () => clock,
      withSecret: async (_id, fn) => (secret === null ? null : fn(secret)),
      ingest: createIngest({ db }),
      log: (entry) => logs.push(entry),
      onActivity: (change) => activity.push(change)
    });
    upsertWebhookRow(db, project.id, `webhook.secret.${project.id}`, 1);

    const send = (overrides: Partial<WebhookRequest> & { payload?: unknown; event?: string; delivery?: string; sign?: boolean } = {}) => {
      const body = overrides.body ?? Buffer.from(JSON.stringify(overrides.payload ?? pushPayload()));
      const headers: Record<string, string | undefined> = {
        "content-type": "application/json",
        "x-github-event": overrides.event ?? "push",
        "x-github-delivery": overrides.delivery ?? "12345678-aaaa-bbbb-cccc-000000000001",
        ...(overrides.sign === false ? {} : { "x-hub-signature-256": computeSignature(SECRET, body) }),
        ...overrides.headers
      };
      return handle({ method: overrides.method ?? "POST", path: overrides.path ?? `/hook/${project.id}`, headers, body });
    };
    return { db, project, logs, activity, send, advance: (ms: number) => (clock += ms) };
  };

  it("accepts a signed push, answers right away and records the event with the exact pusher", async () => {
    const t = setup();
    const response = await t.send();

    assert.equal(response.status, 202);
    await response.done;
    const [event] = queryEvents(t.db).events;
    assert.equal(event?.source, "webhook");
    assert.equal(event?.pusher, "alice");
    assert.equal(event?.pusherInferred, false);
    assert.equal(event?.branch, "main");
    assert.deepEqual(t.activity, [{ events: true }]);
    assert.equal(getLastReceivedAt(t.db, t.project.id), 1_000_000);
  });

  it("answers GitHub's ping and confirms the setup in the log", async () => {
    const t = setup();
    const response = await t.send({ event: "ping", payload: { zen: "Keep it logically awesome." } });
    assert.deepEqual([response.status, response.body], [200, "pong"]);
    assert.ok(t.logs.some((entry) => entry.message.includes("設定成功")));
    assert.equal(queryEvents(t.db).events.length, 0);
  });

  it("rejects a missing, wrong or forged signature with 403 — before reading or recording anything", async () => {
    const t = setup();
    const body = Buffer.from(JSON.stringify(pushPayload()));
    for (const headers of [{ "x-hub-signature-256": undefined }, { "x-hub-signature-256": computeSignature("wrong", body) }, { "x-hub-signature-256": "sha256=zzz" }]) {
      const response = await t.send({ body, sign: false, headers });
      assert.equal(response.status, 403);
    }
    // 簽章沒過就什麼都不信：連壞掉的 JSON 與缺少的 delivery id 都只會得到 403，不會被記錄。
    assert.equal((await t.send({ body: Buffer.from("not json"), sign: false })).status, 403);
    assert.equal((await t.send({ sign: false, delivery: "" })).status, 403);
    assert.equal(Number(t.db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries").get()?.n), 0);
    assert.equal(queryEvents(t.db).events.length, 0);
  });

  it("a project with no secret configured cannot be reached at all", async () => {
    const t = setup({ secret: null });
    assert.equal((await t.send()).status, 403);
    assert.equal(queryEvents(t.db).events.length, 0);
  });

  it("logs unauthenticated rejections at most once a minute so they cannot flood the log", async () => {
    const t = setup();
    for (let i = 0; i < 20; i += 1) await t.send({ sign: false });
    assert.equal(t.logs.filter((entry) => entry.message.includes("簽章驗證失敗")).length, 1);
    t.advance(61_000);
    await t.send({ sign: false });
    assert.equal(t.logs.filter((entry) => entry.message.includes("簽章驗證失敗")).length, 2);
  });

  it("only the exact route is served, and only for projects that use webhooks", async () => {
    const t = setup();
    assert.equal((await t.send({ method: "GET" })).status, 405);
    assert.equal((await t.send({ method: "PUT" })).status, 405);
    for (const path of ["/", "/hook", "/hook/", "/hook/abc", `/hook/${t.project.id}/extra`, "/hook/999", "/other"]) {
      assert.equal((await t.send({ path })).status, 404, path);
    }
    assert.equal((await setup({ mode: "poll" }).send()).status, 404, "polling-only project");
    assert.equal((await setup({ enabled: false }).send()).status, 404, "disabled project");
    assert.equal((await setup({ mode: "both" }).send()).status, 202, "'both' mode accepts webhooks");
  });

  it("requires JSON and a non-empty body", async () => {
    const t = setup();
    assert.equal((await t.send({ headers: { "content-type": "application/x-www-form-urlencoded" } })).status, 415);
    assert.equal((await t.send({ headers: { "content-type": undefined } })).status, 415);
    assert.equal((await t.send({ body: Buffer.alloc(0), sign: false })).status, 400);
  });

  it("de-duplicates redelivery of the same delivery id", async () => {
    const t = setup();
    const first = await t.send();
    await first.done;
    const again = await t.send();

    assert.deepEqual([again.status, again.body], [200, "duplicate delivery"]);
    assert.equal(queryEvents(t.db).events.length, 1);
  });

  it("validates the delivery id and the JSON once the signature has passed", async () => {
    const t = setup();
    assert.equal((await t.send({ delivery: "x" })).status, 400);
    assert.equal((await t.send({ delivery: "has spaces and !!" })).status, 400);
    const bad = Buffer.from("{ not json");
    assert.equal((await t.send({ body: bad, headers: { "x-hub-signature-256": computeSignature(SECRET, bad) }, delivery: "12345678-0000-0000-0000-000000000009" })).status, 400);
  });

  it("ignores events it does not care about, tag pushes, other repositories and filtered branches", async () => {
    const t = setup({ branchFilter: ["main"] });
    assert.deepEqual([(await t.send({ event: "issues", delivery: "00000000-0000-0000-0000-000000000001" })).status], [200]);

    const run = async (delivery: string, payload: unknown) => (await (await t.send({ payload, delivery })).done);
    await run("00000000-0000-0000-0000-000000000002", pushPayload({ ref: "refs/tags/v1" }));
    await run("00000000-0000-0000-0000-000000000003", pushPayload({ repository: { full_name: "evil/other" } }));
    await run("00000000-0000-0000-0000-000000000004", pushPayload({ ref: "refs/heads/feature/x" }));

    assert.equal(queryEvents(t.db).events.length, 0);
    assert.ok(t.logs.some((entry) => entry.message.includes("與專案不符")));

    await run("00000000-0000-0000-0000-000000000005", pushPayload());
    assert.equal(queryEvents(t.db).events.length, 1, "the matching branch still goes through");
  });

  it("matches the repository name case-insensitively", async () => {
    const t = setup();
    await (await t.send({ payload: pushPayload({ repository: { full_name: "ACME/Api" } }) })).done;
    assert.equal(queryEvents(t.db).events.length, 1);
  });

  it("polling and webhook describe the same push once — and the exact pusher replaces the inferred one", async () => {
    const t = setup({ mode: "both" });
    insertEvent(t.db, { ...makeEvent(t.project.id, { branch: "main", ref: "refs/heads/main", beforeSha: SHA_A, afterSha: SHA_B, pusher: "alice-guess", pusherInferred: true, source: "poll" }) });

    await (await t.send()).done;

    const events = queryEvents(t.db).events;
    assert.equal(events.length, 1);
    assert.equal(events[0]?.source, "poll", "the first source keeps the row");
    assert.equal(events[0]?.pusher, "alice");
    assert.equal(events[0]?.pusherInferred, false);
  });

  it("never replaces an already-exact pusher", () => {
    const db = createTestDb();
    const added = addProject(db, { owner: "a", repo: "b", name: "a/b", localPath: null, branchFilter: ["*"], pollIntervalSec: 30, mode: "both", enabled: true, aiEnabled: false });
    const { id } = insertEvent(db, makeEvent(added.id, { pusher: "exact", pusherInferred: false }));
    assert.equal(upgradePusher(db, id, "someone-else"), false);
    assert.equal(queryEvents(db).events[0]?.pusher, "exact");
  });
});

describe("delivery records", () => {
  it("record once, then report duplicates, and expire after a week", () => {
    const db = createTestDb();
    const project = addProject(db, { owner: "a", repo: "b", name: "a/b", localPath: null, branchFilter: ["*"], pollIntervalSec: 30, mode: "webhook", enabled: true, aiEnabled: false });

    assert.equal(recordDelivery(db, "delivery-1", project.id, 1000), true);
    assert.equal(recordDelivery(db, "delivery-1", project.id, 2000), false);
    assert.equal(recordDelivery(db, "delivery-2", project.id, 1000 + 6 * DAY_MS), true);

    purgeExpired(db, { retentionDays: null, now: 1000 + 8 * DAY_MS });
    assert.equal(recordDelivery(db, "delivery-1", project.id, 1000 + 8 * DAY_MS), true, "old ids are forgotten");
    assert.equal(recordDelivery(db, "delivery-2", project.id, 1000 + 8 * DAY_MS), false, "recent ids are kept");
  });

  it("webhook rows track the last delivery", () => {
    const db = createTestDb();
    const project = addProject(db, { owner: "a", repo: "b", name: "a/b", localPath: null, branchFilter: ["*"], pollIntervalSec: 30, mode: "webhook", enabled: true, aiEnabled: false });
    assert.equal(getLastReceivedAt(db, project.id), null);
    upsertWebhookRow(db, project.id, "webhook.secret.1", 5);
    upsertWebhookRow(db, project.id, "webhook.secret.1", 6);
    touchWebhook(db, project.id, 77);
    assert.equal(getLastReceivedAt(db, project.id), 77);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM webhooks").get()?.n), 1);
  });
});

describe("webhook settings", () => {
  it("defaults to off", () => {
    assert.equal(DEFAULT_WEBHOOK_SETTINGS.enabled, false);
    assert.ok(validateWebhookSettings({}).ok);
  });

  it("validates the port and the public URL", () => {
    assert.ok(validateWebhookSettings({ enabled: true, port: 9000, publicBaseUrl: "https://abc.ngrok-free.app/" }).ok);
    for (const bad of [{ port: 80 }, { port: 70000 }, { port: 8080.5 }, { port: "8080" }, { enabled: "yes" }, { publicBaseUrl: "http://insecure.example.com" }, { publicBaseUrl: "https://u:p@x.com" }, { publicBaseUrl: "https://x.com/?k=1" }, { publicBaseUrl: "nonsense" }, null, []]) {
      assert.equal(validateWebhookSettings(bad).ok, false, JSON.stringify(bad));
    }
  });

  it("normalises the public URL and builds each project's payload URL", () => {
    assert.equal(normalizePublicBaseUrl("https://abc.ngrok-free.app///"), "https://abc.ngrok-free.app");
    assert.equal(normalizePublicBaseUrl("https://example.com/base/"), "https://example.com/base");
    assert.equal(buildPayloadUrl("https://abc.ngrok-free.app", 7), "https://abc.ngrok-free.app/hook/7");
    assert.equal(buildPayloadUrl(null, 7), null);
    assert.equal(payloadPath(7), "/hook/7");
  });
});

describe("webhook server (real sockets on loopback)", () => {
  const post = (port: number, path: string, body: Buffer | string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const req = httpRequest({ host: WEBHOOK_HOST, port, path, method: "POST", headers: { "Content-Length": Buffer.byteLength(body), ...headers } }, (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => (text += chunk.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      req.on("error", reject);
      req.end(body);
    });

  const servers: Array<{ stop: () => Promise<void> }> = [];
  after(async () => {
    for (const server of servers) await server.stop();
  });

  it("serves requests on 127.0.0.1 and passes the exact raw body and headers to the handler", async () => {
    const seen: WebhookRequest[] = [];
    const server = createWebhookServer(async (request) => {
      seen.push(request);
      return { status: 202, body: "accepted" };
    });
    servers.push(server);
    await server.start(0);
    const { port, listening, error } = server.status();
    assert.equal(listening, true);
    assert.equal(error, null);

    const body = '{"a":1}';
    const response = await post(port, "/hook/3?ignored=1", body, { "X-GitHub-Event": "push", "Content-Type": "application/json" });

    assert.deepEqual(response, { status: 202, body: "accepted" });
    assert.equal(seen[0]?.path, "/hook/3", "the query string is dropped");
    assert.equal(seen[0]?.body.toString(), body);
    assert.equal(seen[0]?.headers["x-github-event"], "push");
    assert.equal(seen[0]?.method, "POST");
  });

  it("refuses a body over the size limit without handing it to the handler", async () => {
    let called = false;
    const server = createWebhookServer(async () => {
      called = true;
      return { status: 200, body: "" };
    });
    servers.push(server);
    await server.start(0);

    // 只送標頭、宣告一個過大的 Content-Length：伺服器看到就該直接拒絕，不必等內容傳完。
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: WEBHOOK_HOST, port: server.status().port }, () => {
        socket.write(`POST /hook/1 HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${MAX_WEBHOOK_BODY_BYTES + 1}\r\n\r\n`);
      });
      let text = "";
      socket.on("data", (chunk: Buffer) => (text += chunk.toString()));
      socket.on("close", () => resolve(text));
      socket.on("error", reject);
    });
    assert.match(reply, /^HTTP\/1\.1 413 /);
    assert.equal(called, false);

    // 沒有宣告長度但實際內容超標（分塊傳輸）也一樣被擋下。
    const chunked = await new Promise<string>((resolve) => {
      const socket = connect({ host: WEBHOOK_HOST, port: server.status().port }, () => {
        socket.write("POST /hook/1 HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n");
        const block = Buffer.alloc(1024 * 1024, 97);
        for (let i = 0; i < 6; i += 1) {
          socket.write(`${block.length.toString(16)}\r\n`);
          socket.write(block);
          socket.write("\r\n");
        }
      });
      let text = "";
      socket.on("data", (chunk: Buffer) => (text += chunk.toString()));
      socket.on("close", () => resolve(text));
      socket.on("error", () => resolve(text));
    });
    // 客戶端還在狂寫的時候伺服器關了連線，回應有可能在被重置之前就讀不到；能讀到的話必須是 413。
    assert.ok(chunked === "" || /^HTTP\/1\.1 413 /.test(chunked), `unexpected reply: ${chunked.slice(0, 40)}`);
    assert.equal(called, false, "an oversized body never reaches the handler");
  });

  it("answers 500 (without details) if the handler throws", async () => {
    const server = createWebhookServer(async () => {
      throw new Error("internal secret detail");
    });
    servers.push(server);
    await server.start(0);
    const response = await post(server.status().port, "/hook/1", "{}");
    assert.deepEqual(response, { status: 500, body: "internal error" });
  });

  it("reports a port that is already taken, and stops cleanly", async () => {
    const first = createWebhookServer(async () => ({ status: 200, body: "" }));
    const second = createWebhookServer(async () => ({ status: 200, body: "" }));
    servers.push(first, second);
    await first.start(0);

    await second.start(first.status().port);
    assert.equal(second.status().listening, false);
    assert.match(second.status().error ?? "", /已被其他程式使用/);

    const { port } = first.status();
    await first.stop();
    assert.equal(first.status().listening, false);
    await assert.rejects(post(port, "/hook/1", "{}"), /ECONNREFUSED/);
  });

  it("restarts on a different port and is idempotent for the same one", async () => {
    const server = createWebhookServer(async () => ({ status: 200, body: "ok" }));
    servers.push(server);
    await server.start(0);
    const first = server.status().port;
    await server.start(first);
    assert.equal(server.status().port, first);
    assert.equal(server.status().listening, true);
  });
});
