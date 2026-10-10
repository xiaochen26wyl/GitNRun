import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AiResult } from "@shared/ai";
import type { PushEvent } from "@shared/events";
import type { Project } from "@shared/projects";
import type { Rule, RuleAction, RuleInput } from "@shared/rules";
import { outputsEnv } from "@main/exec/env";
import { expandGitArgs } from "@main/exec/git-args";
import { UserFacingError } from "@main/errors";
import { addProject, getProject } from "@main/db/projects-repo";
import { createRule } from "@main/db/rules-repo";
import { asClipboardArgs, asConflictArgs, isKnownChannel } from "@main/ipc-validation";
import { IPC } from "@shared/ipc";
import { testSecret } from "@main/secret-test";
import { createRuleEngine, type ActionContext, type ActionExecutors } from "@main/rules/engine";
import { createAiExecutors } from "@main/rules/executors/ai";
import { createNotifyExecutors, notificationText, webhookPayload } from "@main/rules/executors/notify";
import { createVault } from "@main/vault/vault";
import { createTestDb, storeEvent } from "./helpers/db";
import { createFakeCipher } from "./helpers/fake-cipher";

const ruleInput = (actions: RuleAction[]): RuleInput => ({
  name: "ai flow", enabled: true, priority: 1, matchMode: "all", conditions: [], actions, cooldownSec: 0, skipConfirm: true
});

const fakeAi = (impl: { commit?: () => Promise<AiResult>; summary?: () => Promise<AiResult> } = {}) => ({
  generateCommitMessage: impl.commit ?? (async () => ({ text: "feat: 新增登入", source: "ai" as const, model: "m" })),
  summarizeEventBatched: impl.summary ?? (async () => ({ text: "alice 修改了登入流程。", source: "ai" as const, model: "m" }))
});

describe("outputs flow from one action to the next", () => {
  const setup = (executors: ActionExecutors) => {
    const db = createTestDb();
    const project = addProject(db, {
      owner: "acme", repo: "api", name: "acme/api", localPath: "/p", branchFilter: ["*"],
      pollIntervalSec: 30, mode: "poll", enabled: true, aiEnabled: true
    });
    const engine = createRuleEngine({ db, now: () => 1, executors, confirm: async () => "allow", log: () => undefined });
    return { db, project: getProject(db, project.id) as Project, engine };
  };

  it("a later action sees what an earlier AI action produced", async () => {
    const seen: Array<Readonly<Record<string, string>> | undefined> = [];
    const t = setup({
      ...createAiExecutors(fakeAi()),
      notify_system: { describe: () => "n", run: async (_action: RuleAction, context: ActionContext) => { seen.push(context.variables); return { status: "success", message: "ok" }; } }
    } as unknown as ActionExecutors);
    createRule(t.db, ruleInput([{ type: "ai_summary" }, { type: "ai_commit_message" }, { type: "notify_system" }]));

    const [report] = await t.engine.runForEvent(storeEvent(t.db, t.project.id), t.project);

    assert.equal(report?.status, "success");
    assert.deepEqual(seen[0], { ai_summary: "alice 修改了登入流程。", ai_commit_message: "feat: 新增登入" });
  });

  it("a failed action leaves no output, and outputs never carry over to the next run", async () => {
    const seen: Array<Readonly<Record<string, string>> | undefined> = [];
    let calls = 0;
    const t = setup({
      ...createAiExecutors(fakeAi({ summary: async () => (++calls === 1 ? { text: "第一次的摘要", source: "ai" } : { text: "", source: "offline", reason: "nothing-to-send" }) })),
      notify_system: { describe: () => "n", run: async (_action: RuleAction, context: ActionContext) => { seen.push({ ...context.variables }); return { status: "success", message: "ok" }; } }
    } as unknown as ActionExecutors);
    createRule(t.db, ruleInput([{ type: "ai_summary", continueOnFailure: true }, { type: "notify_system" }]));

    await t.engine.runForEvent(storeEvent(t.db, t.project.id), t.project);
    const [second] = await t.engine.runForEvent(storeEvent(t.db, t.project.id), t.project);

    assert.deepEqual(seen, [{ ai_summary: "第一次的摘要" }, {}], "the second run starts clean and the failed action added nothing");
    assert.equal(second?.status, "failed");
  });
});

describe("AI actions", () => {
  const ctx = (aiEnabled: boolean): ActionContext => ({
    rule: { id: 1, name: "r" } as Rule,
    event: { id: 5, projectId: 1 } as PushEvent,
    project: { id: 1, name: "acme/api", localPath: "/p", aiEnabled } as Project
  });

  it("reports which source produced the text — AI, cache or local rules", async () => {
    const ai = (source: AiResult["source"], reason?: AiResult["reason"]) =>
      createAiExecutors(fakeAi({ commit: async () => ({ text: "docs: 更新說明", source, ...(reason ? { reason } : {}) }) }));

    assert.match((await ai("ai").ai_commit_message!.run({ type: "ai_commit_message" }, ctx(true))).message, /^AI：docs: 更新說明/);
    assert.match((await ai("cache").ai_commit_message!.run({ type: "ai_commit_message" }, ctx(true))).message, /AI（快取）/);
    const local = await ai("offline", "ai-disabled").ai_commit_message!.run({ type: "ai_commit_message" }, ctx(false));
    assert.equal(local.status, "success");
    assert.match(local.message, /本機規則：這個專案尚未允許 AI/);
    assert.deepEqual(local.output, { name: "ai_commit_message", value: "docs: 更新說明" });
  });

  it("fails when there is nothing to work with, and passes on user-facing errors", async () => {
    const empty = createAiExecutors(fakeAi({ commit: async () => ({ text: "", source: "offline", reason: "nothing-to-send" }) }));
    const result = await empty.ai_commit_message!.run({ type: "ai_commit_message" }, ctx(true));
    assert.equal(result.status, "failed");
    assert.equal(result.output, undefined);

    const noPath = createAiExecutors(fakeAi({ commit: async () => { throw new UserFacingError("這個專案還沒有設定本機路徑"); } }));
    assert.equal((await noPath.ai_commit_message!.run({ type: "ai_commit_message" }, ctx(true))).message, "這個專案還沒有設定本機路徑");

    const crash = createAiExecutors(fakeAi({ summary: async () => { throw new Error("secret detail ghp_" + "x".repeat(36)); } }));
    const crashed = await crash.ai_summary!.run({ type: "ai_summary" }, ctx(true));
    assert.equal(crashed.status, "failed");
    assert.ok(!crashed.message.includes("secret detail"));
  });

  it("describes what it will do and whether the project has opted in", () => {
    const executors = createAiExecutors(fakeAi());
    assert.match(String(executors.ai_commit_message!.describe({ type: "ai_commit_message" }, ctx(true))), /排除清單/);
    assert.match(String(executors.ai_commit_message!.describe({ type: "ai_commit_message" }, ctx(false))), /尚未允許 AI/);
    assert.match(String(executors.ai_summary!.describe({ type: "ai_summary" }, ctx(true))), /不送程式碼/);
  });
});

describe("outputs in notifications, shell and git", () => {
  const event = { branch: "main", pusher: "alice", headMessage: "feat: x", afterSha: "a".repeat(40), beforeSha: null, fileCount: 1, commits: [], eventType: "push", files: [] } as unknown as PushEvent;
  const project = { name: "acme/api" } as Project;

  it("notification text can use {ai_summary}", () => {
    assert.deepEqual(notificationText({ title: "{project}", body: "AI 說：{ai_summary}" }, event, project, { ai_summary: "改了登入" }), {
      title: "acme/api", body: "AI 說：改了登入"
    });
    assert.equal(notificationText({ body: "{ai_summary}" }, event, project).body, "{ai_summary}", "unset outputs are left as written");
  });

  it("webhook payloads carry outputs only when there are some", () => {
    assert.equal("outputs" in webhookPayload(event, project, false), false);
    assert.deepEqual((webhookPayload(event, project, false, { ai_summary: "x" }) as { outputs: unknown }).outputs, { ai_summary: "x" });
  });

  it("Slack and system notifications pick the outputs up from the action context", async () => {
    const shown: Array<[string, string]> = [];
    const posts: unknown[] = [];
    const executors = createNotifyExecutors({
      showNotification: (title, body) => void shown.push([title, body]),
      post: async (_url, body) => { posts.push(body); return { status: 200 }; },
      withSlackUrl: async (fn) => fn("https://hooks.slack.com/services/T/B/x")
    });
    const context = { rule: { id: 1 } as Rule, event, project, variables: { ai_summary: "摘要內容" } };

    await executors.notify_system!.run({ type: "notify_system", body: "{ai_summary}" }, context);
    await executors.notify_slack!.run({ type: "notify_slack", text: "{ai_summary}" }, context);

    assert.deepEqual(shown[0]?.[1], "摘要內容");
    assert.deepEqual(posts[0], { text: "摘要內容" });
  });

  it("shell commands get outputs as PW_<NAME> environment variables, never as command text", () => {
    assert.deepEqual(outputsEnv({ ai_summary: "line1\nline2 $(rm -rf /)", ai_commit_message: "feat: x" }), {
      PW_AI_SUMMARY: "line1\nline2 $(rm -rf /)",
      PW_AI_COMMIT_MESSAGE: "feat: x"
    });
    assert.deepEqual(outputsEnv(undefined), {});
    assert.deepEqual(outputsEnv({ "Bad Name": "x", PATH: "/evil", ok_name: "y" }), { PW_OK_NAME: "y" }, "only lower-case identifiers become variables");
    assert.equal(outputsEnv({ big: "x".repeat(9000) }).PW_BIG?.length, 4000);
  });

  it("git commit can use {ai_commit_message} — but only a valid, single-line conventional message", () => {
    const refs = { branch: "main", afterSha: "a".repeat(40), beforeSha: null };
    assert.deepEqual(expandGitArgs(["-m", "{ai_commit_message}"], refs, { ai_commit_message: "feat: 新增登入" }), { ok: true, args: ["-m", "feat: 新增登入"] });

    for (const bad of ["--amend", "feat: x\n\nrm -rf", "just some text", "-m feat: x", "feat: " + "x".repeat(200)]) {
      assert.equal(expandGitArgs(["-m", "{ai_commit_message}"], refs, { ai_commit_message: bad }).ok, false, bad);
    }
    const missing = expandGitArgs(["-m", "{ai_commit_message}"], refs, {});
    assert.ok(!missing.ok);
    assert.match(missing.message, /生成 AI commit 訊息/);
  });
});

describe("testing AI keys", () => {
  it("delegates to the AI service for the AI providers' keys", async () => {
    const vault = createVault(createTestDb(), createFakeCipher());
    const asked: string[] = [];
    const ai = { ping: async (provider: "anthropic" | "openai") => { asked.push(provider); return { ok: provider === "anthropic", message: `ping ${provider}` }; } };
    const noGithub = async () => { throw new Error("must not be called"); };
    const fetchFn = noGithub as never;

    assert.deepEqual(await testSecret(vault, "ai.anthropic", fetchFn, ai), { ok: true, message: "ping anthropic", warnings: [] });
    assert.equal((await testSecret(vault, "ai.openai", fetchFn, ai)).ok, false);
    assert.deepEqual(asked, ["anthropic", "openai"]);
  });

  it("still says AI keys cannot be tested when no AI service is available", async () => {
    const vault = createVault(createTestDb(), createFakeCipher());
    assert.match((await testSecret(vault, "ai.anthropic", (async () => { throw new Error("x"); }) as never)).message, /不支援/);
  });
});

describe("AI IPC arguments", () => {
  it("channels are declared", () => {
    for (const channel of [IPC.aiSettingsGet, IPC.aiSettingsSave, IPC.aiUsage, IPC.aiPreviewCommit, IPC.aiCommitMessage, IPC.aiSummarizeEvent, IPC.aiSuggestEvent, IPC.aiConflicts, IPC.clipboardWrite]) {
      assert.equal(isKnownChannel(channel), true, channel);
    }
  });

  it("clipboard text is one bounded line", () => {
    assert.deepEqual(asClipboardArgs(["feat: 新增登入"]), ["feat: 新增登入"]);
    for (const bad of [[], [""], ["a\nb"], ["x".repeat(501)], [5], ["a", "b"]]) {
      assert.equal(asClipboardArgs(bad), null, JSON.stringify(bad));
    }
  });

  it("conflict prediction takes a project id and an optional branch", () => {
    assert.deepEqual(asConflictArgs([3]), [3, undefined]);
    assert.deepEqual(asConflictArgs([3, "develop"]), [3, "develop"]);
    for (const bad of [[], [0], ["3"], [3, 5], [3, ""], [3, "a".repeat(256)], [3, "x", "y"]]) {
      assert.equal(asConflictArgs(bad), null, JSON.stringify(bad));
    }
  });
});
