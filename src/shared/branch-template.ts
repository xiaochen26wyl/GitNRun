import { matchGlob } from "@shared/glob";

/**
 * 分支命名規則：帶變數的範本（純函式，主程序與渲染層共用）。
 *
 * 預設範本沿用既有慣例：v{version}_{year}_{mmdd}，例如 v010_2026_1009。
 * 範本同時用在兩件事：依範本「產生」新分支名稱，以及把範本轉成比對規則來「檢查」推送上來的分支名稱。
 */

export const TOKEN_NAMES = ["version", "year", "month", "day", "mmdd", "user", "type", "slug", "seq"] as const;
export type TokenName = (typeof TOKEN_NAMES)[number];

export const TOKEN_LABELS: Record<TokenName, string> = {
  version: "版本（去掉小數點，如 0.1.0 → 010）",
  year: "年份（4 位）",
  month: "月（2 位）",
  day: "日（2 位）",
  mmdd: "月日（4 位）",
  user: "使用者（git user.name）",
  type: "類型（feat、fix…）",
  slug: "簡短描述（建立時輸入）",
  seq: "當日流水號"
};

/** 需要使用者在建立分支時輸入的變數。 */
export const INPUT_TOKENS: readonly TokenName[] = ["type", "slug"];
/** 會隨時間或次數變動的變數；範本至少要有一個，否則每次產生的名稱都會一樣。 */
const VARYING_TOKENS: readonly TokenName[] = ["year", "month", "day", "mmdd", "seq", "slug"];

export const DEFAULT_BRANCH_TEMPLATE = "v{version}_{year}_{mmdd}";
export const DEFAULT_EXEMPT_BRANCHES: readonly string[] = ["main", "master", "develop", "release/*"];
export const VERSION_SOURCES = ["package.json", "VERSION", "git-tag"] as const;
export type VersionSource = (typeof VERSION_SOURCES)[number];
export const DEFAULT_VERSION_SOURCE: VersionSource = "package.json";

export const MAX_TEMPLATE_LENGTH = 200;
export const MAX_BRANCH_NAME_LENGTH = 255;

export type BranchValues = Record<TokenName, string>;

export const SAMPLE_VALUES: BranchValues = {
  version: "010",
  year: "2026",
  month: "10",
  day: "09",
  mmdd: "1009",
  user: "alice",
  type: "feat",
  slug: "login-page",
  seq: "1"
};

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

export type TemplatePart = { kind: "text"; text: string } | { kind: "token"; name: TokenName };

export type ParseResult = { ok: true; parts: TemplatePart[] } | { ok: false; errors: string[] };

const isTokenName = (value: string): value is TokenName => (TOKEN_NAMES as readonly string[]).includes(value);

export const parseTemplate = (template: string): ParseResult => {
  const errors: string[] = [];
  const parts: TemplatePart[] = [];
  let text = "";

  for (let i = 0; i < template.length; i += 1) {
    const char = template[i] as string;
    if (char === "{") {
      const end = template.indexOf("}", i);
      if (end === -1) {
        errors.push("有「{」沒有對應的「}」");
        break;
      }
      const name = template.slice(i + 1, end);
      if (!isTokenName(name)) {
        errors.push(`不認得的變數「{${name}}」`);
      } else {
        if (text) {
          parts.push({ kind: "text", text });
          text = "";
        }
        parts.push({ kind: "token", name });
      }
      i = end;
    } else if (char === "}") {
      errors.push("有「}」沒有對應的「{」");
      break;
    } else {
      text += char;
    }
  }
  if (text) {
    parts.push({ kind: "text", text });
  }

  return errors.length > 0 ? { ok: false, errors: [...new Set(errors)] } : { ok: true, parts };
};

export const templateTokens = (parts: readonly TemplatePart[]): TokenName[] => [
  ...new Set(parts.flatMap((part) => (part.kind === "token" ? [part.name] : [])))
];

// ---------------------------------------------------------------------------
// git 分支名稱合法性（等同 git check-ref-format --branch 的規則）
// ---------------------------------------------------------------------------

const FORBIDDEN_CHARS = /[\u0000- \u007f~^:?*[\\]/;

export const isValidBranchName = (name: string): boolean => {
  if (name.length === 0 || name.length > MAX_BRANCH_NAME_LENGTH) return false;
  if (name === "@" || name === "HEAD") return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  if (FORBIDDEN_CHARS.test(name)) return false;
  if (name.includes("..") || name.includes("@{") || name.includes("//")) return false;
  return name.split("/").every((component) => component.length > 0 && !component.startsWith(".") && !component.endsWith(".lock"));
};

// ---------------------------------------------------------------------------
// 驗證與渲染
// ---------------------------------------------------------------------------

export type TemplateValidation = { ok: true; tokens: TokenName[] } | { ok: false; errors: string[] };

export const validateTemplate = (template: unknown): TemplateValidation => {
  if (typeof template !== "string" || template.trim().length === 0) {
    return { ok: false, errors: ["範本不可為空"] };
  }
  if (template.length > MAX_TEMPLATE_LENGTH) {
    return { ok: false, errors: [`範本最長 ${MAX_TEMPLATE_LENGTH} 個字元`] };
  }
  const parsed = parseTemplate(template);
  if (!parsed.ok) {
    return parsed;
  }

  const errors: string[] = [];
  const tokens = templateTokens(parsed.parts);
  if (!tokens.some((token) => VARYING_TOKENS.includes(token))) {
    errors.push("範本至少要有一個會變動的變數（日期、流水號或描述），否則每次產生的名稱都一樣");
  }
  const sample = renderParts(parsed.parts, SAMPLE_VALUES);
  if (!isValidBranchName(sample)) {
    errors.push(`產生的名稱「${sample}」不是合法的 git 分支名稱（不可含空白、~ ^ : ? * [ \\、連續的 .. 等）`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, tokens };
};

const renderParts = (parts: readonly TemplatePart[], values: BranchValues): string =>
  parts.map((part) => (part.kind === "text" ? part.text : values[part.name])).join("");

export class TemplateRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateRenderError";
  }
}

/** 依範本產生分支名稱；缺少範本需要的變數，或結果不合法，都會丟出 TemplateRenderError。 */
export const renderBranchName = (template: string, values: Partial<BranchValues>): string => {
  const parsed = parseTemplate(template);
  if (!parsed.ok) {
    throw new TemplateRenderError(parsed.errors.join("；"));
  }
  for (const token of templateTokens(parsed.parts)) {
    if (!values[token]) {
      throw new TemplateRenderError(`缺少變數 {${token}}`);
    }
  }
  const name = renderParts(parsed.parts, values as BranchValues);
  if (!isValidBranchName(name)) {
    throw new TemplateRenderError(`產生的名稱「${name}」不是合法的 git 分支名稱`);
  }
  return name;
};

export type BranchRuleScopeName = "project" | "global" | "default";

/** 編輯畫面看到的規則：生效的那一份，以及這個範圍自己有沒有覆寫。 */
export interface BranchRuleView {
  template: string;
  versionSource: VersionSource;
  exempt: string[];
  scope: BranchRuleScopeName;
  hasOwn: boolean;
}

export interface BranchRuleFormInput {
  template: string;
  versionSource: VersionSource;
  exempt: string[];
}

export type BranchRuleValidation = { ok: true; value: BranchRuleFormInput } | { ok: false; errors: string[] };

const MAX_EXEMPT_ENTRIES = 50;
const MAX_EXEMPT_LENGTH = 200;

/** 儲存分支規則前的整體驗證（範本、版本來源、豁免清單）。 */
export const validateBranchRuleInput = (raw: unknown): BranchRuleValidation => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["輸入格式不正確"] };
  }
  const input = raw as Record<string, unknown>;
  const errors: string[] = [];

  const template = typeof input.template === "string" ? input.template.trim() : "";
  const templateCheck = validateTemplate(template);
  if (!templateCheck.ok) {
    errors.push(...templateCheck.errors);
  }

  const versionSource = VERSION_SOURCES.find((source) => source === input.versionSource);
  if (!versionSource) {
    errors.push("版本來源不正確");
  }

  let exempt: string[] = [];
  if (!Array.isArray(input.exempt) || input.exempt.length > MAX_EXEMPT_ENTRIES) {
    errors.push(`豁免清單最多 ${MAX_EXEMPT_ENTRIES} 項`);
  } else if (
    input.exempt.some(
      (item) => typeof item !== "string" || item.trim().length === 0 || item.length > MAX_EXEMPT_LENGTH || /[\u0000-\u001f\u007f]/.test(item)
    )
  ) {
    errors.push("豁免清單含有不正確的項目");
  } else {
    exempt = (input.exempt as string[]).map((item) => item.trim());
  }

  return errors.length > 0 || !versionSource
    ? { ok: false, errors }
    : { ok: true, value: { template, versionSource, exempt } };
};

// ---------------------------------------------------------------------------
// 變數值的來源與淨化
// ---------------------------------------------------------------------------

const pad2 = (value: number): string => String(value).padStart(2, "0");

export const dateValues = (date: Date): Pick<BranchValues, "year" | "month" | "day" | "mmdd"> => ({
  year: String(date.getFullYear()),
  month: pad2(date.getMonth() + 1),
  day: pad2(date.getDate()),
  mmdd: `${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`
});

/** "v0.1.0"、"0.1.0-beta.1" → "010"；解析不出數字版本就回傳 null。 */
export const normalizeVersion = (raw: string): string | null => {
  const match = /^v?(\d+(?:\.\d+)*)/.exec(raw.trim());
  return match?.[1] ? match[1].replaceAll(".", "") : null;
};

/** 使用者輸入的描述／名稱 → 可安全放進分支名稱的小寫片段；淨化後為空則回傳 null。 */
export const sanitizeSlug = (input: string, maxLength = 50): string | null => {
  const slug = input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : null;
};

export const TYPE_PATTERN = /^[a-z]{2,12}$/;
export const COMMON_TYPES: readonly string[] = ["feat", "fix", "chore", "docs", "refactor", "test", "style", "hotfix"];

// ---------------------------------------------------------------------------
// 檢查：把範本轉成比對規則
// ---------------------------------------------------------------------------

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

const TOKEN_PATTERN: Record<TokenName, string> = {
  version: "\\d+",
  year: "\\d{4}",
  month: "\\d{2}",
  day: "\\d{2}",
  mmdd: "\\d{4}",
  user: "[\\p{L}\\p{N}._-]+",
  type: "[a-z]{2,12}",
  slug: "[\\p{L}\\p{N}-]+",
  seq: "\\d+"
};

/** 範本無法解析時回傳 null（呼叫端應視為「不檢查」，而不是把所有分支都判成違規）。 */
export const templateToMatcher = (template: string): RegExp | null => {
  const parsed = parseTemplate(template);
  if (!parsed.ok) {
    return null;
  }
  const source = parsed.parts
    .map((part) => (part.kind === "text" ? escapeRegExp(part.text) : TOKEN_PATTERN[part.name]))
    .join("");
  return new RegExp(`^${source}$`, "u");
};

export type BranchCheck = "ok" | "exempt" | "violation";

export interface BranchRule {
  template: string;
  exempt: readonly string[];
}

/** 豁免清單為空代表沒有任何分支被豁免（不同於 matchesAnyGlob 的「空＝不限制」）。 */
export const checkBranchName = (name: string, rule: BranchRule): BranchCheck => {
  if (rule.exempt.some((pattern) => matchGlob(pattern, name))) {
    return "exempt";
  }
  const matcher = templateToMatcher(rule.template);
  if (matcher === null) {
    return "ok";
  }
  return matcher.test(name) ? "ok" : "violation";
};
