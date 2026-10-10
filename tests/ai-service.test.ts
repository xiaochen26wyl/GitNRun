import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AiProvider } from "@shared/ai";
import { DEFAULT_AI_SETTINGS } from "@shared/ai";
import { createBatcher } from "@main/ai/batcher";
import { AiProviderError, type AiClient, type AiRequest } from "@main/ai/providers";
import { createAiService, readAiSettings } from "@main/ai/service";
import { UserFacingError } from "@main/errors";
import { addProject, getProject } from "@main/db/projects-repo";
import type { GitResult, GitRunner } from "@main/git/run-git";
import type { LogEntry } from "@main/logger";
import { createVault } from "@main/vault/vault";
import { createTestDb, storeEvent } from "./helpers/db";
import { createFakeCipher } from "./helpers/fake-cipher";

const ANTHROPIC_KEY = "sk-ant-api03-" + "abcdefghijklmnopqrstuv";
const GITHUB_TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

/** 每次呼叫都不同的差異（變化放在會送出的檔案裡，不是被排除的 .env）。 */
const variant = (n: number): string => DIFF.replace("+export const login = () => true;", `+export const login = () => ${n};`);

const DIFF = [
  "diff --git a/src/login.ts b/src/login.ts",
  "index 1..2 100644",
  "--- a/src/login.ts",
  "+++ b/src/login.ts",
  "@@ -1 +1,3 @@",
  `+const token = "${GITHUB_TOKEN}";`,
  "+export const login = () => true;",
  "diff --git a/.env b/.env",
  "+DB_PASSWORD=never-send-this-123"
].join("\n");

interface Setup {
  aiEnabled?: boolean;
  key?: boolean;
  settings?: Record<string, unknown>;
  reply?: string | (() => string);
  fail?: AiProviderError;
  git?: (key: string) => Partial<GitResult> | undefined;
  localPath?: string | null;
}

const setup = (options: Setup = {}) => {
  const db = createTestDb();
  const cipher = createFakeCipher();
  const vault = createVault(db, cipher);
  if (options.key !== false) vault.set("ai.anthropic", ANTHROPIC_KEY);

  const added = addProject(db, {
    owner: "acme", repo: "api", name: "acme/api", localPath: options.localPath === undefined ? "/Users/me/api" : options.localPath,
    branchFilter: ["*"], pollIntervalSec: 30, mode: "poll", enabled: true, aiEnabled: options.aiEnabled ?? true
  });
  db.prepare("UPDATE projects SET default_branch = 'main' WHERE id = ?").run(added.id);
  const project = getProject(db, added.id)!;

  const requests: Array<{ request: AiRequest; apiKey: string }> = [];
  const clients: Record<AiProvider, AiClient> = {
    anthropic: {
      complete: async (request, apiKey) => {
        requests.push({ request, apiKey });
        if (options.fail) throw options.fail;
        const text = typeof options.reply === "function" ? options.reply() : (options.reply ?? "feat: 新增登入");
        return { text, inputTokens: 100, outputTokens: 10 };
      }
    },
    openai: { complete: async () => { throw new Error("openai should not be called"); } }
  };

  const gitCalls: string[] = [];
  const runGit: GitRunner = async (_cwd, args) => {
    const key = args.join(" ");
    gitCalls.push(key);
    const isPatch = key.endsWith("--no-textconv --cached") || key.endsWith("--no-textconv HEAD");
    const defaults: Partial<GitResult> = key.includes("--name-status")
      ? { stdout: "M\tsrc/login.ts\nM\t.env\n" }
      : isPatch ? { stdout: DIFF } : {};
    return { code: 0, stdout: "", stderr: "", timedOut: false, ...defaults, ...options.git?.(key) };
  };

  const logs: LogEntry[] = [];
  let clock = 10_000_000;
  const timers: Array<() => void> = [];
  const service = createAiService({
    db, vault, clients, runGit,
    now: () => clock,
    log: (entry) => logs.push(entry),
    schedule: (fn) => void timers.push(fn)
  });
  if (options.settings) service.saveSettings(options.settings);

  return {
    db, vault, service, project, requests, gitCalls, logs, timers,
    advance: (ms: number) => (clock += ms),
    runTimers: () => timers.splice(0).forEach((fn) => fn())
  };
};

describe("commit message generation", () => {
  it("asks the model, validates the reply, and reports it as an AI result", async () => {
    const t = setup();
    const result = await t.service.generateCommitMessage(t.project.id);

    assert.deepEqual(result, { text: "feat: 新增登入", source: "ai", model: "claude-haiku-5-5" });
    assert.equal(t.requests.length, 1);
    assert.equal(t.requests[0]?.apiKey, ANTHROPIC_KEY);
    assert.equal(t.requests[0]?.request.model, "claude-haiku-5-5");
    assert.equal(t.requests[0]?.request.maxTokens, 120);
  });

  it("sends neither excluded files nor anything that looks like a secret", async () => {
    const t = setup();
    await t.service.generateCommitMessage(t.project.id);

    const prompt = t.requests[0]?.request.user ?? "";
    assert.ok(prompt.includes("export const login"), "ordinary code is sent");
    assert.ok(!prompt.includes("never-send-this-123"), ".env content is never sent");
    assert.ok(!prompt.includes(GITHUB_TOKEN), "token-looking text is masked");
    assert.ok(prompt.includes("[內容已排除，不會送出]"));
    assert.ok(!t.requests[0]?.request.system.includes(ANTHROPIC_KEY));
  });

  it("previews exactly what would be sent, without calling anything", async () => {
    const t = setup();
    const preview = await t.service.previewCommitMessage(t.project.id);

    assert.ok(preview);
    assert.deepEqual(preview.files, ["src/login.ts"]);
    assert.deepEqual(preview.excludedFiles, [".env"]);
    assert.equal(preview.maskedCount, 1);
    assert.equal(preview.provider, "anthropic");
    assert.ok(!preview.diff.includes("never-send-this-123") && !preview.diff.includes(GITHUB_TOKEN));
    assert.equal(t.requests.length, 0);
  });

  it("never calls the model for a project that has not opted in — and says why", async () => {
    const t = setup({ aiEnabled: false });
    const result = await t.service.generateCommitMessage(t.project.id);

    assert.equal(result.source, "offline");
    assert.equal(result.reason, "ai-disabled");
    assert.match(result.text, /^(feat|fix|chore|docs|refactor|style|test): /);
    assert.equal(t.requests.length, 0);
  });

  it("falls back to local rules when there is no key, no model, or the provider fails", async () => {
    const noKey = setup({ key: false });
    assert.equal((await noKey.service.generateCommitMessage(noKey.project.id)).reason, "no-key");

    const noModel = setup({ settings: { provider: "openai" } });
    noModel.vault.set("ai.openai", "sk-proj-abcdefghijklmnopqrstuvwxyz");
    assert.equal((await noModel.service.generateCommitMessage(noModel.project.id)).reason, "model-missing");

    const down = setup({ fail: new AiProviderError("unavailable", 503) });
    const result = await down.service.generateCommitMessage(down.project.id);
    assert.equal(result.reason, "provider-error");
    assert.equal(result.source, "offline");
    assert.match(result.text, /^chore: |^feat: /);
  });

  it("uses the local fallback when the reply is not a valid commit message, and does not cache it", async () => {
    const t = setup({ reply: "當然！這是一則很棒的 commit 訊息：新增登入" });
    const first = await t.service.generateCommitMessage(t.project.id);
    assert.equal(first.reason, "invalid-output");

    await t.service.generateCommitMessage(t.project.id);
    assert.equal(t.requests.length, 2, "an invalid reply is not served from cache");
  });

  it("reports when there is nothing to commit, and when everything is excluded", async () => {
    const empty = setup({ git: (key) => (key.includes("--name-status") ? { stdout: "" } : undefined) });
    const none = await empty.service.generateCommitMessage(empty.project.id);
    assert.equal(none.reason, "nothing-to-send");
    assert.equal(empty.requests.length, 0);

    const onlySecrets = setup({
      git: (key) => (key.includes("--name-status") ? { stdout: "M\t.env\n" } : key.endsWith("--cached") ? { stdout: "diff --git a/.env b/.env\n+SECRET=x" } : undefined)
    });
    const result = await onlySecrets.service.generateCommitMessage(onlySecrets.project.id);
    assert.equal(result.reason, "nothing-to-send");
    assert.equal(onlySecrets.requests.length, 0, "nothing at all is sent when every file is excluded");
  });

  it("reports git errors and a missing local path", async () => {
    const broken = setup({ git: () => ({ code: 128, stderr: "fatal: not a git repository" }) });
    assert.equal((await broken.service.generateCommitMessage(broken.project.id)).reason, "git-error");

    const noPath = setup({ localPath: null });
    await assert.rejects(noPath.service.generateCommitMessage(noPath.project.id), UserFacingError);
    await assert.rejects(noPath.service.generateCommitMessage(999), UserFacingError);
  });

  it("falls back to unstaged changes when nothing is staged", async () => {
    const t = setup({ git: (key) => (key.includes("--cached") && key.includes("--name-status") ? { stdout: "" } : undefined) });
    const result = await t.service.generateCommitMessage(t.project.id);
    assert.equal(result.source, "ai");
    assert.ok(t.gitCalls.some((call) => call.endsWith("HEAD --name-status")));
  });
});

describe("cost control", () => {
  it("serves identical requests from the local cache instead of calling again", async () => {
    const t = setup();
    const first = await t.service.generateCommitMessage(t.project.id);
    const second = await t.service.generateCommitMessage(t.project.id);

    assert.equal(first.source, "ai");
    assert.equal(second.source, "cache");
    assert.equal(second.text, first.text);
    assert.equal(t.requests.length, 1);
    assert.equal(t.service.usage().cacheHitsToday, 1);
  });

  it("the cache expires after the configured time", async () => {
    const t = setup({ settings: { cacheTtlHours: 1 } });
    await t.service.generateCommitMessage(t.project.id);
    t.advance(2 * 60 * 60 * 1000);
    assert.equal((await t.service.generateCommitMessage(t.project.id)).source, "ai");
    assert.equal(t.requests.length, 2);
  });

  it("a different change is a different request", async () => {
    let diff = DIFF;
    const t = setup({ git: (key) => (key.endsWith("--no-textconv --cached") ? { stdout: diff } : undefined) });
    await t.service.generateCommitMessage(t.project.id);
    diff = DIFF.replace("login = () => true", "logout = () => false");
    await t.service.generateCommitMessage(t.project.id);
    assert.equal(t.requests.length, 2);
  });

  it("stops at the per-minute limit and recovers when the minute passes", async () => {
    const replies = ["feat: 一", "feat: 二", "feat: 三", "feat: 四"];
    let call = 0;
    let diffNumber = 0;
    const t = setup({
      settings: { ratePerMinute: 2 },
      reply: () => replies[call++] ?? "feat: 其他",
      git: (key) => (key.endsWith("--no-textconv --cached") ? { stdout: variant(diffNumber) } : undefined)
    });
    const ask = async () => {
      diffNumber += 1;
      return t.service.generateCommitMessage(t.project.id);
    };

    assert.equal((await ask()).source, "ai");
    assert.equal((await ask()).source, "ai");
    const limited = await ask();
    assert.equal(limited.reason, "rate-limited");
    assert.equal(t.requests.length, 2, "the third call never leaves the machine");

    t.advance(61_000);
    assert.equal((await ask()).source, "ai");
  });

  it("stops at the daily limit", async () => {
    let n = 0;
    const t = setup({ settings: { dailyLimit: 2, ratePerMinute: 60 }, git: (key) => (key.endsWith("--no-textconv --cached") ? { stdout: variant(n) } : undefined) });
    for (; n < 2; n += 1) {
      assert.equal((await t.service.generateCommitMessage(t.project.id)).source, "ai");
      t.advance(2 * 60_000);
    }
    n += 1;
    assert.equal((await t.service.generateCommitMessage(t.project.id)).reason, "daily-limit");
    assert.equal(t.requests.length, 2);
  });

  it("failed calls count against the limits, so a broken key cannot be hammered", async () => {
    let n = 0;
    const t = setup({ settings: { ratePerMinute: 2 }, fail: new AiProviderError("auth", 401), git: (key) => (key.endsWith("--no-textconv --cached") ? { stdout: variant(n) } : undefined) });
    for (; n < 4; n += 1) await t.service.generateCommitMessage(t.project.id);
    assert.equal(t.requests.length, 2);
  });

  it("reports usage", async () => {
    const t = setup();
    await t.service.generateCommitMessage(t.project.id);
    const usage = t.service.usage();
    assert.equal(usage.callsToday, 1);
    assert.equal(usage.inputTokensToday, 100);
    assert.equal(usage.outputTokensToday, 10);
    assert.equal(usage.dailyLimit, DEFAULT_AI_SETTINGS.dailyLimit);
  });
});

describe("what is recorded", () => {
  it("never writes the API key, the prompt or a secret into logs or the call table", async () => {
    const t = setup();
    await t.service.generateCommitMessage(t.project.id);

    const everything = JSON.stringify([t.logs, t.db.prepare("SELECT * FROM ai_calls").all()]);
    assert.ok(!everything.includes(ANTHROPIC_KEY));
    assert.ok(!everything.includes(GITHUB_TOKEN));
    assert.ok(!everything.includes("export const login"), "the code that was sent is not stored");
    assert.ok(everything.includes("feat: 新增登入"), "the reply is stored (that is the cache)");
  });

  it("logs a provider failure by kind only", async () => {
    const t = setup({ fail: new AiProviderError("auth", 401) });
    await t.service.generateCommitMessage(t.project.id);
    assert.ok(t.logs.some((entry) => entry.level === "warn" && entry.message.includes("auth")));
  });
});

describe("event summaries, suggestions", () => {
  it("summarises from commit messages and file names only — never code", async () => {
    const t = setup({ reply: "alice 修改了登入流程。" });
    const event = storeEvent(t.db, t.project.id, {
      headMessage: "feat: login", commits: [{ sha: "a".repeat(40), message: "feat: login", author: "alice", timestamp: 1 }],
      files: [{ path: "src/login.ts", status: "modified" }], fileCount: 1
    });

    const result = await t.service.summarizeEvent(event.id);

    assert.deepEqual([result.source, result.text], ["ai", "alice 修改了登入流程。"]);
    const prompt = t.requests[0]?.request.user ?? "";
    assert.match(prompt, /feat: login/);
    assert.match(prompt, /src\/login\.ts/);
    assert.equal(t.requests[0]?.request.model, "claude-haiku-5-5");
  });

  it("uses the deeper model for suggestions", async () => {
    const t = setup({ reply: "• 看起來可以合併" });
    const event = storeEvent(t.db, t.project.id, { files: [{ path: "a.ts", status: "modified" }], fileCount: 1 });
    await t.service.suggestForEvent(event.id);
    assert.equal(t.requests[0]?.request.model, "claude-sonnet-5-5");
  });

  it("falls back to local summaries and suggestions when AI is off for the project", async () => {
    const t = setup({ aiEnabled: false });
    const event = storeEvent(t.db, t.project.id, { pusher: "alice", headMessage: "feat: x", branchViolation: true });
    const summary = await t.service.summarizeEvent(event.id);
    const suggestion = await t.service.suggestForEvent(event.id);

    assert.equal(summary.reason, "ai-disabled");
    assert.match(summary.text, /alice/);
    assert.equal(suggestion.reason, "ai-disabled");
    assert.match(suggestion.text, /命名規則/);
    assert.equal(t.requests.length, 0);
  });

  it("rejects unknown events", async () => {
    const t = setup();
    await assert.rejects(t.service.summarizeEvent(999), UserFacingError);
    await assert.rejects(t.service.suggestForEvent(999), UserFacingError);
  });

  it("merges events that arrive within the batching window into one request", async () => {
    const t = setup({ settings: { batchWindowSec: 3 }, reply: "三次推送都在調整登入。" });
    const events = [1, 2, 3].map((n) => storeEvent(t.db, t.project.id, { headMessage: `feat: step ${n}`, branch: `b${n}`, ref: `refs/heads/b${n}` }));

    const pending = events.map((event) => t.service.summarizeEventBatched(event.id));
    await Promise.resolve();
    assert.equal(t.requests.length, 0, "nothing is sent until the window closes");
    t.runTimers();
    const results = await Promise.all(pending);

    assert.equal(t.requests.length, 1, "three events, one request");
    assert.ok(results.every((result) => result.text === "三次推送都在調整登入。"));
    const prompt = t.requests[0]?.request.user ?? "";
    assert.ok(["step 1", "step 2", "step 3"].every((step) => prompt.includes(step)));
  });

  it("does not batch when the window is 0", async () => {
    const t = setup({ settings: { batchWindowSec: 0 } });
    const event = storeEvent(t.db, t.project.id);
    await t.service.summarizeEventBatched(event.id);
    assert.equal(t.requests.length, 1);
    assert.equal(t.timers.length, 0);
  });
});

describe("conflict prediction", () => {
  const mergeTree = (out: Partial<GitResult>) => (key: string) => (key.startsWith("merge-tree") ? out : undefined);

  it("reports a clean merge without calling AI", async () => {
    const t = setup({ git: mergeTree({ code: 0, stdout: "abc\n" }) });
    const report = await t.service.predictConflicts(t.project.id);
    assert.deepEqual(report, { files: [], clean: true, detail: "", explanation: null });
    assert.ok(t.gitCalls.includes("merge-tree --write-tree --name-only HEAD origin/main"));
    assert.equal(t.requests.length, 0);
  });

  it("lists conflicting files from git and asks AI only to explain them (names, not code)", async () => {
    const t = setup({
      reply: "兩邊都改了登入函式。",
      git: mergeTree({ code: 1, stdout: "abc\nsrc/login.ts\n\nCONFLICT (content): Merge conflict in src/login.ts\n" })
    });
    const report = await t.service.predictConflicts(t.project.id);

    assert.equal(report.clean, false);
    assert.deepEqual(report.files, ["src/login.ts"]);
    assert.equal(report.explanation?.source, "ai");
    const prompt = t.requests[0]?.request.user ?? "";
    assert.match(prompt, /src\/login\.ts/);
    assert.match(prompt, /origin\/main/);
    assert.equal(t.requests[0]?.request.model, "claude-sonnet-5-5");
  });

  it("explains locally when AI is off", async () => {
    const t = setup({ aiEnabled: false, git: mergeTree({ code: 1, stdout: "abc\na.ts\nb.ts\n\nmsg" }) });
    const report = await t.service.predictConflicts(t.project.id);
    assert.equal(report.explanation?.source, "offline");
    assert.match(report.explanation?.text ?? "", /2 個檔案衝突/);
    assert.equal(t.requests.length, 0);
  });

  it("refuses a hostile branch name and explains an old git", async () => {
    const t = setup({ git: mergeTree({ code: 129, stderr: "usage: git merge-tree" }) });
    await assert.rejects(t.service.predictConflicts(t.project.id, "--upload-pack=evil"), UserFacingError);
    await assert.rejects(t.service.predictConflicts(t.project.id), (error) => error instanceof UserFacingError && error.message.includes("2.38"));
    assert.ok(!t.gitCalls.some((call) => call.includes("upload-pack")));
  });

  it("reports git errors without leaking secrets from stderr", async () => {
    const t = setup({ git: mergeTree({ code: 128, stderr: `fatal: bad object https://x:${GITHUB_TOKEN}@github.com/a/b` }) });
    await assert.rejects(t.service.predictConflicts(t.project.id), (error) => error instanceof UserFacingError && !error.message.includes(GITHUB_TOKEN));
  });
});

describe("settings and ping", () => {
  it("validates before saving, and falls back to defaults if the stored value is corrupt", () => {
    const t = setup();
    assert.throws(() => t.service.saveSettings({ ratePerMinute: 0 }), UserFacingError);
    assert.equal(t.service.getSettings().ratePerMinute, DEFAULT_AI_SETTINGS.ratePerMinute);

    t.service.saveSettings({ ratePerMinute: 9 });
    assert.equal(readAiSettings(t.db).ratePerMinute, 9);

    t.db.prepare("UPDATE settings SET value = '{\"ratePerMinute\":-5}' WHERE key = 'ai.settings'").run();
    assert.deepEqual(readAiSettings(t.db), DEFAULT_AI_SETTINGS);
  });

  it("ping reports success and translates failures", async () => {
    const ok = setup();
    assert.deepEqual(await ok.service.ping("anthropic"), { ok: true, message: "連線成功（claude-haiku-5-5）" });

    const bad = setup({ fail: new AiProviderError("auth", 401) });
    const result = await bad.service.ping("anthropic");
    assert.equal(result.ok, false);
    assert.match(result.message, /金鑰/);

    const noModel = setup();
    assert.match((await noModel.service.ping("openai")).message, /模型/);
    const noKey = setup({ key: false });
    assert.equal((await noKey.service.ping("anthropic")).ok, false);
  });
});

describe("batcher", () => {
  it("shares one result among everyone who asked inside the window, per key", async () => {
    const calls: Array<[string, number[]]> = [];
    const timers: Array<() => void> = [];
    const batcher = createBatcher<string, number, string>({
      windowMs: () => 100,
      run: async (key, items) => { calls.push([key, items]); return `${key}:${items.join(",")}`; },
      schedule: (fn) => void timers.push(fn)
    });

    const a1 = batcher.submit("a", 1);
    const a2 = batcher.submit("a", 2);
    const b1 = batcher.submit("b", 9);
    timers.splice(0).forEach((fn) => fn());

    assert.deepEqual(await Promise.all([a1, a2, b1]), ["a:1,2", "a:1,2", "b:9"]);
    assert.deepEqual(calls, [["a", [1, 2]], ["b", [9]]]);
  });

  it("starts a fresh window after a flush, and rejects every waiter when the run fails", async () => {
    const timers: Array<() => void> = [];
    let fail = true;
    const batcher = createBatcher<string, number, number>({
      windowMs: () => 50,
      run: async (_key, items) => { if (fail) throw new Error("boom"); return items.length; },
      schedule: (fn) => void timers.push(fn)
    });

    const first = [batcher.submit("k", 1), batcher.submit("k", 2)].map((promise) => promise.catch((error: Error) => error.message));
    timers.splice(0).forEach((fn) => fn());
    assert.deepEqual(await Promise.all(first), ["boom", "boom"]);

    fail = false;
    const second = batcher.submit("k", 3);
    timers.splice(0).forEach((fn) => fn());
    assert.equal(await second, 1);
  });
});
