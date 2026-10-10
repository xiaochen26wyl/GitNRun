/** AI 推送助手的共用型別、預設值與設定驗證（純函式）。 */

export const AI_PROVIDERS = ["anthropic", "openai"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  anthropic: "Anthropic（Claude）",
  openai: "OpenAI"
};

export const AI_PURPOSES = ["commit_message", "summary", "suggest", "conflict", "ping"] as const;
export type AiPurpose = (typeof AI_PURPOSES)[number];

export interface AiPrompts {
  commit: string;
  summary: string;
  suggest: string;
  conflict: string;
}

export interface AiSettings {
  provider: AiProvider;
  /** Anthropic：commit 訊息與摘要用的快速模型。 */
  anthropicFastModel: string;
  /** Anthropic：推送建議、衝突說明這類需要多一點推理的模型。 */
  anthropicDeepModel: string;
  /** OpenAI 的模型名稱由使用者自填（型號更新很快，不內建預設）。 */
  openaiModel: string;
  /** 送出的差異內容上限（位元組），超過就截斷。 */
  maxDiffBytes: number;
  /** 這些檔案的內容絕不送出（檔名樣式，沒有 / 的樣式比對檔名）。 */
  excludeGlobs: string[];
  ratePerMinute: number;
  dailyLimit: number;
  /** 同一專案在這段時間內的多筆事件合併成一次請求；0 = 不合併。 */
  batchWindowSec: number;
  cacheTtlHours: number;
  prompts: AiPrompts;
}

export const DEFAULT_EXCLUDE_GLOBS: readonly string[] = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.keystore",
  "id_rsa*",
  "id_ed25519*",
  "*secret*",
  "*credential*",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "*.lock",
  "*.min.js",
  "*.map"
];

export const DEFAULT_PROMPTS: AiPrompts = {
  commit: [
    "請根據下面的程式碼變更，寫一則 commit 訊息。",
    "格式：<type>: <簡短說明>",
    "type 只能是 feat、fix、chore、docs、refactor、style、test 其中之一。",
    "說明用繁體中文一句話，不超過 50 個字。",
    "只輸出這一行，不要加引號、說明或其他文字。",
    "",
    "專案：{project}",
    "分支：{branch}",
    "變更檔案：",
    "{files}",
    "",
    "差異內容：",
    "{diff}"
  ].join("\n"),
  summary: [
    "請用繁體中文摘要下面這次（或這幾次）推送做了什麼，3 句話以內，點出最值得注意的變更與可能的風險。",
    "",
    "專案：{project}",
    "分支：{branch}",
    "推送者：{pusher}",
    "Commit 訊息：",
    "{commits}",
    "變更檔案：",
    "{files}"
  ].join("\n"),
  suggest: [
    "請根據下面的推送資訊，判斷這次推送是否建議合併或發佈，用繁體中文列出最多 3 點理由與需要注意的事。",
    "",
    "專案：{project}",
    "分支：{branch}（命名{branchStatus}）",
    "變更檔案數：{fileCount}",
    "Commit 訊息：",
    "{commits}",
    "變更檔案：",
    "{files}"
  ].join("\n"),
  conflict: [
    "下面是合併時預測會衝突的檔案與 git 的說明。請用繁體中文用白話解釋可能的原因，並建議怎麼處理，5 行以內。",
    "",
    "專案：{project}",
    "合併：{head} ← {against}",
    "衝突檔案：",
    "{files}",
    "git 說明：",
    "{messages}"
  ].join("\n")
};

export const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: "anthropic",
  anthropicFastModel: "claude-haiku-5-5",
  anthropicDeepModel: "claude-sonnet-5-5",
  openaiModel: "",
  maxDiffBytes: 60_000,
  excludeGlobs: [...DEFAULT_EXCLUDE_GLOBS],
  ratePerMinute: 6,
  dailyLimit: 100,
  batchWindowSec: 3,
  cacheTtlHours: 72,
  prompts: { ...DEFAULT_PROMPTS }
};

export type AiSettingsValidation = { ok: true; value: AiSettings } | { ok: false; errors: string[] };

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_PROMPT = 8000;
const MAX_GLOBS = 100;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const validateAiSettings = (raw: unknown): AiSettingsValidation => {
  if (!isRecord(raw)) {
    return { ok: false, errors: ["輸入格式不正確"] };
  }
  const errors: string[] = [];
  const merged = { ...DEFAULT_AI_SETTINGS, ...raw, prompts: { ...DEFAULT_PROMPTS, ...(isRecord(raw.prompts) ? raw.prompts : {}) } };

  const provider = AI_PROVIDERS.find((candidate) => candidate === merged.provider);
  if (!provider) {
    errors.push("AI 供應商不正確");
  }

  const model = (value: unknown, label: string, allowEmpty: boolean): string => {
    if (typeof value !== "string") {
      errors.push(`${label}需為文字`);
      return "";
    }
    const trimmed = value.trim();
    if (trimmed === "" ? !allowEmpty : !MODEL_PATTERN.test(trimmed)) {
      errors.push(`${label}不正確（只能包含英數字與 . _ : / -）`);
    }
    return trimmed;
  };
  const anthropicFastModel = model(merged.anthropicFastModel, "Anthropic 快速模型", false);
  const anthropicDeepModel = model(merged.anthropicDeepModel, "Anthropic 進階模型", false);
  const openaiModel = model(merged.openaiModel, "OpenAI 模型", true);

  const int = (value: unknown, label: string, min: number, max: number): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
      errors.push(`${label}需介於 ${min} 到 ${max}`);
      return min;
    }
    return value;
  };
  const maxDiffBytes = int(merged.maxDiffBytes, "差異內容上限（位元組）", 1_000, 500_000);
  const ratePerMinute = int(merged.ratePerMinute, "每分鐘呼叫上限", 1, 60);
  const dailyLimit = int(merged.dailyLimit, "每日呼叫上限", 1, 10_000);
  const batchWindowSec = int(merged.batchWindowSec, "合併事件的時間窗（秒）", 0, 30);
  const cacheTtlHours = int(merged.cacheTtlHours, "快取保留時間（小時）", 1, 720);

  let excludeGlobs: string[] = [];
  if (!Array.isArray(merged.excludeGlobs) || merged.excludeGlobs.length > MAX_GLOBS) {
    errors.push(`排除清單最多 ${MAX_GLOBS} 項`);
  } else if (merged.excludeGlobs.some((item) => typeof item !== "string" || item.trim() === "" || item.length > 200 || CONTROL.test(item))) {
    errors.push("排除清單含有不正確的項目");
  } else {
    excludeGlobs = (merged.excludeGlobs as string[]).map((item) => item.trim());
  }

  const prompts = merged.prompts as Record<string, unknown>;
  const prompt = (key: keyof AiPrompts, label: string): string => {
    const value = prompts[key];
    if (typeof value !== "string" || value.trim() === "" || value.length > MAX_PROMPT) {
      errors.push(`${label}提示詞需為 1～${MAX_PROMPT} 字`);
      return "";
    }
    return value;
  };
  const checked: AiPrompts = {
    commit: prompt("commit", "Commit 訊息"),
    summary: prompt("summary", "摘要"),
    suggest: prompt("suggest", "推送建議"),
    conflict: prompt("conflict", "衝突說明")
  };

  if (errors.length > 0 || !provider) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      provider,
      anthropicFastModel,
      anthropicDeepModel,
      openaiModel,
      maxDiffBytes,
      excludeGlobs,
      ratePerMinute,
      dailyLimit,
      batchWindowSec,
      cacheTtlHours,
      prompts: checked
    }
  };
};

// ---------------------------------------------------------------------------
// 結果
// ---------------------------------------------------------------------------

/** 為什麼沒有用 AI（改走本機備用方案）。 */
export type AiOfflineReason =
  | "ai-disabled"
  | "no-key"
  | "model-missing"
  | "rate-limited"
  | "daily-limit"
  | "provider-error"
  | "invalid-output"
  | "nothing-to-send"
  | "git-error";

export const OFFLINE_REASON_TEXT: Record<AiOfflineReason, string> = {
  "ai-disabled": "這個專案尚未允許 AI 分析，改用本機規則",
  "no-key": "尚未設定 AI 金鑰，改用本機規則",
  "model-missing": "尚未設定 OpenAI 模型名稱，改用本機規則",
  "rate-limited": "已達每分鐘呼叫上限，改用本機規則",
  "daily-limit": "已達每日呼叫上限，改用本機規則",
  "provider-error": "AI 服務暫時無法使用，改用本機規則",
  "invalid-output": "AI 的回覆格式不符，改用本機規則",
  "nothing-to-send": "沒有可分析的內容",
  "git-error": "讀取本機 git 變更失敗"
};

export interface AiResult {
  text: string;
  source: "ai" | "cache" | "offline";
  reason?: AiOfflineReason;
  model?: string;
}

export interface OutgoingPreview {
  provider: AiProvider;
  model: string;
  /** 會送出內容的檔案。 */
  files: string[];
  /** 因排除清單而不會送出內容的檔案。 */
  excludedFiles: string[];
  /** 送出前被遮蔽的疑似密鑰數量。 */
  maskedCount: number;
  bytes: number;
  truncated: boolean;
  /** 實際會送出的差異內容（已遮蔽）。 */
  diff: string;
}

export interface AiUsage {
  callsToday: number;
  dailyLimit: number;
  callsLastMinute: number;
  ratePerMinute: number;
  cacheHitsToday: number;
  inputTokensToday: number;
  outputTokensToday: number;
}

export interface ConflictReport {
  /** 預測合併時會衝突的檔案；沒有衝突為空陣列。 */
  files: string[];
  clean: boolean;
  /** git 的原始說明（已脫敏、已截斷）。 */
  detail: string;
  explanation: AiResult | null;
}

/** 規則動作的輸出變數名稱（後面的動作可以用 {ai_summary}、環境變數 PW_AI_SUMMARY 取得）。 */
export const AI_OUTPUT_VARIABLES = ["ai_summary", "ai_commit_message"] as const;
