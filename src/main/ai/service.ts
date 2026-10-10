import { createHash } from "node:crypto";
import {
  DEFAULT_AI_SETTINGS,
  validateAiSettings,
  type AiOfflineReason,
  type AiProvider,
  type AiPurpose,
  type AiResult,
  type AiSettings,
  type AiUsage,
  type ConflictReport,
  type OutgoingPreview
} from "@shared/ai";
import { isValidBranchName } from "@shared/branch-template";
import type { PushEvent } from "@shared/events";
import type { Project } from "@shared/projects";
import { collectLocalChanges } from "@main/ai/local-changes";
import { createBatcher } from "@main/ai/batcher";
import { parseMergeTree } from "@main/ai/conflicts";
import { prepareDiff } from "@main/ai/diff-prep";
import { offlineCommitMessage, offlineSuggestion, offlineSummary } from "@main/ai/offline";
import {
  MAX_TOKENS,
  SYSTEM_PROMPT,
  formatCommitList,
  formatFileList,
  normalizeCommitMessage,
  renderPrompt
} from "@main/ai/prompts";
import type { AiClient } from "@main/ai/providers";
import type { Db } from "@main/db/database";
import { findCachedResponse, countRealCalls, readUsage, recordAiCall } from "@main/db/ai-repo";
import { getEvent } from "@main/db/events-repo";
import { getProject } from "@main/db/projects-repo";
import { getSetting, setSetting } from "@main/db/settings-repo";
import { UserFacingError } from "@main/errors";
import type { GitRunner } from "@main/git/run-git";
import { redactSecrets } from "@main/log-redaction";
import type { LogEntry } from "@main/logger";
import type { Vault } from "@main/vault/vault";

/**
 * AI 推送助手。
 *
 * 一次 AI 呼叫的流程：專案有開啟 → 有金鑰與模型 → 送出內容先經過排除與遮蔽 → 查快取 →
 * 檢查頻率／每日額度 → 才真的呼叫。任何一步走不通，都改用本機備用方案，並告訴使用者原因。
 */

export const AI_SETTINGS_KEY = "ai.settings";
const KEY_NAMES: Record<AiProvider, string> = { anthropic: "ai.anthropic", openai: "ai.openai" };
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MESSAGE_LIMIT = 4_000;

export const readAiSettings = (db: Db): AiSettings => {
  const stored = getSetting<unknown>(db, AI_SETTINGS_KEY, null);
  if (stored === null) return DEFAULT_AI_SETTINGS;
  const result = validateAiSettings(stored);
  return result.ok ? result.value : DEFAULT_AI_SETTINGS;
};

export interface AiServiceDeps {
  db: Db;
  now: () => number;
  vault: Pick<Vault, "has" | "useSecret">;
  clients: Record<AiProvider, AiClient>;
  runGit: GitRunner;
  log: (entry: LogEntry) => void;
  schedule?: (fn: () => void, ms: number) => void;
}

export interface AiService {
  getSettings(): AiSettings;
  saveSettings(raw: unknown): AiSettings;
  usage(): AiUsage;
  /** 唯讀：這次會送出什麼（已排除、已遮蔽）。 */
  previewCommitMessage(projectId: number): Promise<OutgoingPreview | null>;
  generateCommitMessage(projectId: number): Promise<AiResult>;
  summarizeEvent(eventId: number): Promise<AiResult>;
  /** 規則動作用：同一專案短時間內的多筆事件合併成一次請求。 */
  summarizeEventBatched(eventId: number): Promise<AiResult>;
  suggestForEvent(eventId: number): Promise<AiResult>;
  predictConflicts(projectId: number, against?: string): Promise<ConflictReport>;
  /** 用一個極短的請求確認金鑰可用（「測試連線」）。 */
  ping(provider: AiProvider): Promise<{ ok: boolean; message: string }>;
}

type Completion =
  | { ok: true; text: string; source: "ai" | "cache"; model: string }
  | { ok: false; reason: AiOfflineReason };

interface CompleteArgs {
  purpose: AiPurpose;
  projectId: number | null;
  tier: "fast" | "deep";
  user: string;
  maxTokens: number;
  /** 回傳 null 代表格式不符（視為失敗，不快取）。 */
  validate?: (text: string) => string | null;
}

const offline = (text: string, reason: AiOfflineReason): AiResult => ({ text, source: "offline", reason });

export const createAiService = (deps: AiServiceDeps): AiService => {
  const { db } = deps;

  const modelFor = (settings: AiSettings, tier: "fast" | "deep"): string =>
    settings.provider === "anthropic" ? (tier === "fast" ? settings.anthropicFastModel : settings.anthropicDeepModel) : settings.openaiModel;

  const complete = async (args: CompleteArgs): Promise<Completion> => {
    const settings = readAiSettings(db);
    const provider = settings.provider;
    const model = modelFor(settings, args.tier);
    if (model === "") {
      return { ok: false, reason: "model-missing" };
    }
    const keyName = KEY_NAMES[provider];
    if (!deps.vault.has(keyName)) {
      return { ok: false, reason: "no-key" };
    }

    const now = deps.now();
    const inputHash = createHash("sha256").update(`${provider}\n${model}\n${SYSTEM_PROMPT}\n${args.user}`).digest("hex");
    const base = { projectId: args.projectId, provider, model, purpose: args.purpose, inputHash };

    const cached = findCachedResponse(db, inputHash, model, now - settings.cacheTtlHours * HOUR_MS);
    if (cached !== null) {
      recordAiCall(db, { ...base, ts: now, cacheHit: true, inputTokens: null, outputTokens: null, status: "ok", responseText: cached });
      return { ok: true, text: cached, source: "cache", model };
    }

    if (countRealCalls(db, now - MINUTE_MS) >= settings.ratePerMinute) {
      return { ok: false, reason: "rate-limited" };
    }
    if (countRealCalls(db, now - DAY_MS) >= settings.dailyLimit) {
      return { ok: false, reason: "daily-limit" };
    }

    let response: Awaited<ReturnType<AiClient["complete"]>>;
    try {
      response = await deps.vault.useSecret(keyName, (apiKey) =>
        deps.clients[provider].complete({ model, system: SYSTEM_PROMPT, user: args.user, maxTokens: args.maxTokens }, apiKey)
      );
    } catch (error) {
      recordAiCall(db, { ...base, ts: now, cacheHit: false, inputTokens: null, outputTokens: null, status: "error", responseText: null });
      // 只記錄錯誤種類；錯誤物件與回應內容可能含有我們送出的程式碼。
      const kind = error instanceof Error && "kind" in error ? String((error as { kind: unknown }).kind) : "unknown";
      deps.log({ category: "ai", level: "warn", message: `AI 呼叫失敗（${provider}／${args.purpose}）：${kind}` });
      return { ok: false, reason: "provider-error" };
    }

    const text = redactSecrets(response.text).trim();
    const checked = args.validate ? args.validate(text) : text;
    const usage = { inputTokens: response.inputTokens, outputTokens: response.outputTokens };
    if (checked === null || checked === "") {
      recordAiCall(db, { ...base, ts: now, cacheHit: false, ...usage, status: "invalid", responseText: null });
      return { ok: false, reason: "invalid-output" };
    }
    recordAiCall(db, { ...base, ts: now, cacheHit: false, ...usage, status: "ok", responseText: checked });
    deps.log({
      category: "ai",
      level: "info",
      message: `AI 完成（${provider}／${model}／${args.purpose}）`,
      detail: { inputTokens: response.inputTokens, outputTokens: response.outputTokens }
    });
    return { ok: true, text: checked, source: "ai", model };
  };

  const toResult = (completion: Completion, fallback: string): AiResult =>
    completion.ok
      ? { text: completion.text, source: completion.source, model: completion.model }
      : offline(fallback, completion.reason);

  const requireProject = (id: number): Project => {
    const project = getProject(db, id);
    if (!project) throw new UserFacingError("找不到這個專案");
    return project;
  };

  const requireEvent = (id: number): { event: PushEvent; project: Project } => {
    const event = getEvent(db, id);
    if (!event) throw new UserFacingError("找不到這個事件");
    return { event, project: requireProject(event.projectId) };
  };

  /** 沒有 commit 清單的事件（例如沒有新 commit 的新分支）改用 head 的訊息，提示詞才不會是空的。 */
  const commitsOf = (event: PushEvent): Array<{ message: string; author: string }> =>
    event.commits.length > 0 ? event.commits : event.headMessage ? [{ message: event.headMessage, author: event.pusher ?? "未知" }] : [];

  const eventVariables = (project: Project, event: PushEvent): Record<string, string> => ({
    project: project.name,
    branch: event.branch,
    pusher: event.pusher ?? "（未知）",
    commits: formatCommitList(commitsOf(event)),
    files: formatFileList(event.files),
    fileCount: String(event.fileCount),
    branchStatus: event.branchViolation ? "不符合規則" : "符合規則"
  });

  const summarizeEvents = async (projectId: number, eventIds: readonly number[]): Promise<AiResult> => {
    const project = requireProject(projectId);
    const events = [...new Set(eventIds)].flatMap((id) => {
      const event = getEvent(db, id);
      return event ? [event] : [];
    });
    const fallback = events.map((event) => offlineSummary(event)).join("\n");
    if (!project.aiEnabled) return offline(fallback, "ai-disabled");
    if (events.length === 0) return offline("", "nothing-to-send");

    const settings = readAiSettings(db);
    const first = events[0] as PushEvent;
    const variables = {
      ...eventVariables(project, first),
      branch: [...new Set(events.map((event) => event.branch))].join("、"),
      pusher: [...new Set(events.flatMap((event) => (event.pusher ? [event.pusher] : [])))].join("、") || "（未知）",
      commits: formatCommitList(events.flatMap(commitsOf)),
      files: formatFileList(events.flatMap((event) => event.files))
    };
    // 摘要只用 commit 訊息與檔名，不送程式碼內容。
    const user = renderPrompt(settings.prompts.summary, variables).slice(0, settings.maxDiffBytes);
    return toResult(await complete({ purpose: "summary", projectId, tier: "fast", user, maxTokens: MAX_TOKENS.text }), fallback);
  };

  const batcher = createBatcher<number, number, AiResult>({
    windowMs: () => readAiSettings(db).batchWindowSec * 1000,
    run: summarizeEvents,
    schedule: deps.schedule
  });

  return {
    getSettings: () => readAiSettings(db),

    saveSettings(raw) {
      const result = validateAiSettings(raw);
      if (!result.ok) {
        throw new UserFacingError(result.errors.join("\n"));
      }
      setSetting(db, AI_SETTINGS_KEY, result.value);
      return result.value;
    },

    usage() {
      const settings = readAiSettings(db);
      return readUsage(db, deps.now(), { dailyLimit: settings.dailyLimit, ratePerMinute: settings.ratePerMinute });
    },

    async previewCommitMessage(projectId) {
      const project = requireProject(projectId);
      if (!project.localPath) throw new UserFacingError("這個專案還沒有設定本機路徑");
      const changes = await collectLocalChanges(deps.runGit, project.localPath);
      if (!changes.ok) return null;

      const settings = readAiSettings(db);
      const prepared = prepareDiff(changes.changes.diff, { excludeGlobs: settings.excludeGlobs, maxBytes: settings.maxDiffBytes });
      return {
        provider: settings.provider,
        model: modelFor(settings, "fast"),
        files: prepared.includedFiles,
        excludedFiles: prepared.excludedFiles,
        maskedCount: prepared.maskedCount,
        bytes: prepared.bytes,
        truncated: prepared.truncated,
        diff: prepared.text
      };
    },

    async generateCommitMessage(projectId) {
      const project = requireProject(projectId);
      if (!project.localPath) throw new UserFacingError("這個專案還沒有設定本機路徑");

      const changes = await collectLocalChanges(deps.runGit, project.localPath);
      if (!changes.ok) {
        return offline("", changes.reason);
      }
      const fallback = offlineCommitMessage(changes.changes.files);
      if (!project.aiEnabled) return offline(fallback, "ai-disabled");

      const settings = readAiSettings(db);
      const prepared = prepareDiff(changes.changes.diff, { excludeGlobs: settings.excludeGlobs, maxBytes: settings.maxDiffBytes });
      // 全部都被排除：沒有任何內容可以送，只能靠檔案路徑推斷。
      if (prepared.includedFiles.length === 0) return offline(fallback, "nothing-to-send");

      const user = renderPrompt(settings.prompts.commit, {
        project: project.name,
        branch: "（目前分支）",
        files: formatFileList(changes.changes.files),
        diff: prepared.text
      });
      const completion = await complete({
        purpose: "commit_message",
        projectId,
        tier: "fast",
        user,
        maxTokens: MAX_TOKENS.commit,
        validate: normalizeCommitMessage
      });
      return toResult(completion, fallback);
    },

    async summarizeEvent(eventId) {
      const { event } = requireEvent(eventId);
      return summarizeEvents(event.projectId, [eventId]);
    },

    async summarizeEventBatched(eventId) {
      const { event } = requireEvent(eventId);
      return batcher.submit(event.projectId, eventId);
    },

    async suggestForEvent(eventId) {
      const { event, project } = requireEvent(eventId);
      const fallback = offlineSuggestion(event);
      if (!project.aiEnabled) return offline(fallback, "ai-disabled");
      if (event.eventType === "delete") return offline(fallback, "nothing-to-send");

      const settings = readAiSettings(db);
      const user = renderPrompt(settings.prompts.suggest, eventVariables(project, event)).slice(0, settings.maxDiffBytes);
      return toResult(
        await complete({ purpose: "suggest", projectId: project.id, tier: "deep", user, maxTokens: MAX_TOKENS.text }),
        fallback
      );
    },

    async predictConflicts(projectId, against) {
      const project = requireProject(projectId);
      if (!project.localPath) throw new UserFacingError("這個專案還沒有設定本機路徑");
      const target = against ?? project.defaultBranch;
      if (!target || !isValidBranchName(target)) {
        throw new UserFacingError("找不到要比對的分支（預設分支尚未知道，或名稱不合法）");
      }

      // 只讀：比較目前的 HEAD 與最近一次 fetch 下來的 origin/<分支>，不改動工作區。
      const merge = await deps.runGit(project.localPath, ["merge-tree", "--write-tree", "--name-only", "HEAD", `origin/${target}`]);
      const outcome = parseMergeTree(merge.code, merge.stdout, merge.stderr);
      if (outcome.kind === "unsupported") {
        throw new UserFacingError("衝突預測需要 git 2.38 以上的版本");
      }
      if (outcome.kind === "error") {
        throw new UserFacingError(`無法預測衝突：${redactSecrets(outcome.detail).slice(0, 200) || "請先 fetch，並確認分支存在"}`);
      }
      if (outcome.kind === "clean") {
        return { files: [], clean: true, detail: "", explanation: null };
      }

      const detail = redactSecrets(outcome.messages).slice(0, MESSAGE_LIMIT);
      const fallback = `預測會有 ${outcome.files.length} 個檔案衝突：${outcome.files.slice(0, 10).join("、")}。請在合併前先處理這些檔案。`;
      let explanation: AiResult;
      if (!project.aiEnabled) {
        explanation = offline(fallback, "ai-disabled");
      } else {
        const settings = readAiSettings(db);
        // 只送檔名與 git 自己的說明，不送程式碼內容。
        const user = renderPrompt(settings.prompts.conflict, {
          project: project.name,
          head: "目前分支",
          against: `origin/${target}`,
          files: outcome.files.slice(0, 40).map((file) => `- ${file}`).join("\n"),
          messages: detail || "（無）"
        });
        explanation = toResult(
          await complete({ purpose: "conflict", projectId, tier: "deep", user, maxTokens: MAX_TOKENS.text }),
          fallback
        );
      }
      return { files: outcome.files, clean: false, detail, explanation };
    },

    async ping(provider) {
      const settings = readAiSettings(db);
      const model = provider === "anthropic" ? settings.anthropicFastModel : settings.openaiModel;
      if (model === "") {
        return { ok: false, message: "請先在 AI 設定填入模型名稱" };
      }
      try {
        await deps.vault.useSecret(KEY_NAMES[provider], (apiKey) =>
          deps.clients[provider].complete({ model, system: "Reply with the single word: ok", user: "ping", maxTokens: 8 }, apiKey)
        );
        return { ok: true, message: `連線成功（${model}）` };
      } catch (error) {
        const kind = error instanceof Error && "kind" in error ? String((error as { kind: unknown }).kind) : "";
        const text: Record<string, string> = {
          auth: "金鑰無效或沒有權限",
          "rate-limited": "已達供應商的頻率限制，稍後再試",
          invalid: "請求被拒絕，請確認模型名稱是否正確",
          unavailable: "無法連線到 AI 服務"
        };
        return { ok: false, message: text[kind] ?? "尚未設定金鑰，或金鑰無法解密" };
      }
    }
  };
};

