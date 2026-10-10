import type { EventType, PushEvent } from "@shared/events";
import type { Project } from "@shared/projects";

/**
 * 規則的型別與驗證（純函式）。規則 = 觸發條件 + 動作清單。
 * 備份匯入、規則匯入、IPC 儲存都用同一套驗證；清單外的動作類型一律拒絕。
 */

// ---------------------------------------------------------------------------
// 動作類型白名單
// ---------------------------------------------------------------------------

export const ACTION_TYPES = [
  "ai_commit_message",
  "ai_summary",
  "git",
  "shell",
  "create_work_branch",
  "notify_system",
  "notify_slack",
  "notify_webhook",
  "notify_email"
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

export const isActionType = (value: unknown): value is ActionType =>
  typeof value === "string" && (ACTION_TYPES as readonly string[]).includes(value);

/** 寫入型動作：預設需人工確認後才執行；其餘（通知、摘要、AI 分析）自動執行。 */
export const WRITE_ACTION_TYPES: ReadonlySet<ActionType> = new Set<ActionType>([
  "git",
  "shell",
  "create_work_branch",
  "notify_webhook",
  "notify_email"
]);

export const isWriteAction = (type: ActionType): boolean => WRITE_ACTION_TYPES.has(type);

export const ACTION_LABELS: Record<ActionType, string> = {
  ai_commit_message: "生成 AI commit 訊息",
  ai_summary: "AI 摘要推送內容",
  git: "執行 Git 指令",
  shell: "執行自訂終端機指令",
  create_work_branch: "開工（依規則建立並推送分支）",
  notify_system: "系統通知",
  notify_slack: "Slack 通知",
  notify_webhook: "外送 Webhook",
  notify_email: "電子郵件"
};

export const GIT_COMMANDS = ["fetch", "pull", "push", "commit", "merge", "checkout", "branch"] as const;
export type GitCommand = (typeof GIT_COMMANDS)[number];

// ---------------------------------------------------------------------------
// 條件
// ---------------------------------------------------------------------------

export const CONDITION_TYPES = [
  "branch",
  "file",
  "pusher",
  "time",
  "file_count",
  "branch_violation",
  "event_type",
  "project"
] as const;
export type ConditionType = (typeof CONDITION_TYPES)[number];

export const CONDITION_LABELS: Record<ConditionType, string> = {
  branch: "分支",
  file: "檔案類型",
  pusher: "推送者",
  time: "時間範圍",
  file_count: "變更檔案數量",
  branch_violation: "分支名稱是否合規",
  event_type: "事件類型",
  project: "專案"
};

export type RuleCondition =
  | { type: "branch"; patterns: string[] }
  | { type: "file"; patterns: string[] }
  | { type: "pusher"; names: string[] }
  | { type: "time"; from: string; to: string; days: number[]; match: "inside" | "outside" }
  | { type: "file_count"; op: "gte" | "lte"; value: number }
  | { type: "branch_violation"; value: boolean }
  | { type: "event_type"; types: EventType[] }
  | { type: "project"; projectIds: number[] };

// ---------------------------------------------------------------------------
// 動作
// ---------------------------------------------------------------------------

interface ActionBase {
  /** 這個動作失敗（或被拒絕、逾時）後，是否繼續執行後面的動作。 */
  continueOnFailure?: boolean;
}

export interface EnvVar {
  name: string;
  value: string;
}

/** 指令失敗（非 0 結束或逾時）後的重試。非冪等的指令不建議重試。 */
export interface RetryPolicy {
  /** 額外重試幾次（不含第一次）。 */
  retries: number;
  /** 第一次重試前等多久；之後每次加倍，最多 5 分鐘。 */
  retryDelaySec: number;
}

export type RuleAction =
  | (ActionBase & { type: "ai_commit_message" })
  | (ActionBase & { type: "ai_summary" })
  | (ActionBase &
      RetryPolicy & {
        type: "git";
        command: GitCommand;
        /** 可用 {branch}、{sha}、{before_sha}，會先驗證再代入；其餘一律原樣當字面參數。 */
        args: string[];
        timeoutSec: number;
      })
  | (ActionBase &
      RetryPolicy & {
        type: "shell";
        command: string;
        timeoutSec: number;
        env: EnvVar[];
        /** 值存在保險庫（env.<ruleId>.<NAME>）的敏感環境變數名稱；規則儲存後才能設定值。 */
        secretEnvNames: string[];
      })
  | (ActionBase & { type: "create_work_branch"; branchType?: string; slug?: string })
  | (ActionBase & { type: "notify_system"; title?: string; body?: string })
  | (ActionBase & { type: "notify_slack"; text?: string })
  | (ActionBase & { type: "notify_webhook"; url: string; includeEvent: boolean })
  | (ActionBase & { type: "notify_email"; to: string; subject?: string });

export interface RuleInput {
  name: string;
  enabled: boolean;
  /** 數字越小越先執行。 */
  priority: number;
  matchMode: "all" | "any";
  conditions: RuleCondition[];
  actions: RuleAction[];
  /** 同一規則在同一專案同一分支上，兩次執行之間至少間隔多少秒。0 = 不限。 */
  cooldownSec: number;
  /** 寫入型動作免確認（風險自負）。 */
  skipConfirm: boolean;
}

export interface Rule extends RuleInput {
  id: number;
  createdAt: number;
  updatedAt: number;
}

export const DEFAULT_COOLDOWN_SEC = 0;
export const DEFAULT_PRIORITY = 100;
export const DEFAULT_SHELL_TIMEOUT_SEC = 30;
export const DEFAULT_GIT_TIMEOUT_SEC = 60;
export const MAX_SHELL_TIMEOUT_SEC = 3600;
export const DEFAULT_RETRIES = 0;
export const MAX_RETRIES = 5;
export const DEFAULT_RETRY_DELAY_SEC = 5;
export const MAX_RETRY_DELAY_SEC = 300;

/**
 * 規則不能自己設定的環境變數：PW_* 是事件資料專用；其餘會改變 shell、git、動態連結或
 * Node 的行為，被拿來夾帶程式碼的風險太高（尤其是匯入來路不明的規則時）。
 */
const RESERVED_ENV_NAMES: ReadonlySet<string> = new Set([
  "PATH", "HOME", "SHELL", "USER", "LOGNAME", "IFS", "TERM", "BASH_ENV", "ENV", "ZDOTDIR", "NODE_OPTIONS"
]);
const RESERVED_ENV_PREFIXES = ["PW_", "DYLD_", "LD_", "GIT_"] as const;

export const isReservedEnvName = (name: string): boolean =>
  RESERVED_ENV_NAMES.has(name) || RESERVED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));

// ---------------------------------------------------------------------------
// 驗證
// ---------------------------------------------------------------------------

export type RuleValidation = { ok: true; value: RuleInput } | { ok: false; errors: string[] };

const MAX_CONDITIONS = 20;
const MAX_ACTIONS = 20;
const MAX_PATTERNS = 50;
const MAX_PATTERN_LENGTH = 200;
const MAX_GIT_ARGS = 20;
const MAX_GIT_ARG_LENGTH = 500;
const MAX_SHELL_LENGTH = 8192;
const MAX_ENV = 30;
const CONTROL = /[\u0000-\u001f\u007f]/;
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const EVENT_TYPES: readonly EventType[] = ["push", "create", "delete"];
const SIMPLE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

class Issues {
  readonly list: string[] = [];

  add(path: string, message: string): void {
    if (this.list.length < 25) {
      this.list.push(`${path}：${message}`);
    }
  }

  text(value: unknown, path: string, max: number, options: { empty?: boolean; control?: boolean } = {}): string {
    if (typeof value !== "string" || value.length > max || (!options.empty && value.trim().length === 0)) {
      this.add(path, `需要 1～${max} 字的文字`);
      return "";
    }
    if (!options.control && CONTROL.test(value)) {
      this.add(path, "不可含控制字元");
      return "";
    }
    return value;
  }

  optionalText(value: unknown, path: string, max: number): string | undefined {
    return value === undefined || value === "" ? undefined : this.text(value, path, max);
  }

  int(value: unknown, path: string, min: number, max: number): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
      this.add(path, `需要 ${min}～${max} 的整數`);
      return min;
    }
    return value;
  }

  stringList(value: unknown, path: string, options: { max: number; item: number }): string[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > options.max) {
      this.add(path, `需要 1～${options.max} 個項目`);
      return [];
    }
    return value.map((item, index) => this.text(item, `${path}[${index + 1}]`, options.item));
  }
}

const validateCondition = (raw: unknown, path: string, issues: Issues): RuleCondition | null => {
  if (!isRecord(raw)) {
    issues.add(path, "格式不正確");
    return null;
  }
  switch (raw.type) {
    case "branch":
    case "file":
      return { type: raw.type, patterns: issues.stringList(raw.patterns, `${path}.patterns`, { max: MAX_PATTERNS, item: MAX_PATTERN_LENGTH }) };
    case "pusher":
      return { type: "pusher", names: issues.stringList(raw.names, `${path}.names`, { max: MAX_PATTERNS, item: 100 }) };
    case "time": {
      const from = typeof raw.from === "string" && TIME_OF_DAY.test(raw.from) ? raw.from : null;
      const to = typeof raw.to === "string" && TIME_OF_DAY.test(raw.to) ? raw.to : null;
      if (from === null || to === null) {
        issues.add(path, "起訖時間需為 HH:MM");
      }
      const days = Array.isArray(raw.days) ? raw.days : [];
      const validDays =
        days.length > 0 && days.length <= 7 && days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) && new Set(days).size === days.length;
      if (!validDays) {
        issues.add(`${path}.days`, "需要 0（週日）～6（週六）且不重複的星期");
      }
      const match = raw.match === "inside" || raw.match === "outside" ? raw.match : null;
      if (match === null) {
        issues.add(`${path}.match`, "需為 inside 或 outside");
      }
      return { type: "time", from: from ?? "00:00", to: to ?? "00:00", days: validDays ? (days as number[]) : [], match: match ?? "inside" };
    }
    case "file_count": {
      const op = raw.op === "gte" || raw.op === "lte" ? raw.op : null;
      if (op === null) {
        issues.add(`${path}.op`, "需為 gte 或 lte");
      }
      return { type: "file_count", op: op ?? "gte", value: issues.int(raw.value, `${path}.value`, 0, 100000) };
    }
    case "branch_violation":
      if (typeof raw.value !== "boolean") {
        issues.add(`${path}.value`, "需為 true 或 false");
      }
      return { type: "branch_violation", value: raw.value === true };
    case "event_type": {
      const types = Array.isArray(raw.types) ? raw.types : [];
      const valid = types.length > 0 && types.every((type) => EVENT_TYPES.includes(type as EventType));
      if (!valid) {
        issues.add(`${path}.types`, "需為 push、create、delete 的子集");
      }
      return { type: "event_type", types: valid ? [...new Set(types as EventType[])] : [] };
    }
    case "project": {
      const ids = Array.isArray(raw.projectIds) ? raw.projectIds : [];
      const valid = ids.length > 0 && ids.length <= MAX_PATTERNS && ids.every((id) => Number.isSafeInteger(id) && id > 0);
      if (!valid) {
        issues.add(`${path}.projectIds`, "需要至少一個專案");
      }
      return { type: "project", projectIds: valid ? (ids as number[]) : [] };
    }
    default:
      issues.add(`${path}.type`, `不認得的條件類型（可用：${CONDITION_TYPES.join("、")}）`);
      return null;
  }
};

const retryPolicy = (raw: Record<string, unknown>, path: string, issues: Issues): RetryPolicy => ({
  retries: raw.retries === undefined ? DEFAULT_RETRIES : issues.int(raw.retries, `${path}.retries`, 0, MAX_RETRIES),
  retryDelaySec:
    raw.retryDelaySec === undefined ? DEFAULT_RETRY_DELAY_SEC : issues.int(raw.retryDelaySec, `${path}.retryDelaySec`, 1, MAX_RETRY_DELAY_SEC)
});

/** 拿掉值為 undefined 的欄位，讓驗證結果與 JSON 往返後完全一致。 */
const compact = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;

const validateAction = (raw: unknown, path: string, issues: Issues): RuleAction | null => {
  if (!isRecord(raw)) {
    issues.add(path, "格式不正確");
    return null;
  }
  if (!isActionType(raw.type)) {
    issues.add(`${path}.type`, `不認得的動作類型（可用：${ACTION_TYPES.join("、")}）`);
    return null;
  }
  const base: ActionBase = {};
  if (raw.continueOnFailure !== undefined) {
    if (typeof raw.continueOnFailure === "boolean") {
      base.continueOnFailure = raw.continueOnFailure;
    } else {
      issues.add(`${path}.continueOnFailure`, "需為 true 或 false");
    }
  }

  switch (raw.type) {
    case "ai_commit_message":
    case "ai_summary":
      return { ...base, type: raw.type };

    case "git": {
      const command = GIT_COMMANDS.find((candidate) => candidate === raw.command);
      if (!command) {
        issues.add(`${path}.command`, `不允許的 git 子指令（可用：${GIT_COMMANDS.join("、")}）`);
      }
      const args = raw.args === undefined ? [] : Array.isArray(raw.args) && raw.args.length <= MAX_GIT_ARGS ? raw.args : null;
      if (args === null) {
        issues.add(`${path}.args`, `最多 ${MAX_GIT_ARGS} 個參數`);
      }
      return {
        ...base,
        ...retryPolicy(raw, path, issues),
        type: "git",
        command: command ?? "fetch",
        args: (args ?? []).map((arg, index) => issues.text(arg, `${path}.args[${index + 1}]`, MAX_GIT_ARG_LENGTH)),
        timeoutSec: raw.timeoutSec === undefined ? DEFAULT_GIT_TIMEOUT_SEC : issues.int(raw.timeoutSec, `${path}.timeoutSec`, 1, MAX_SHELL_TIMEOUT_SEC)
      };
    }

    case "shell": {
      const env = raw.env === undefined ? [] : Array.isArray(raw.env) && raw.env.length <= MAX_ENV ? raw.env : null;
      if (env === null) {
        issues.add(`${path}.env`, `最多 ${MAX_ENV} 個環境變數`);
      }
      const secretNames = raw.secretEnvNames === undefined ? [] : Array.isArray(raw.secretEnvNames) && raw.secretEnvNames.length <= MAX_ENV ? raw.secretEnvNames : null;
      if (secretNames === null) {
        issues.add(`${path}.secretEnvNames`, `最多 ${MAX_ENV} 個敏感環境變數`);
      }
      return {
        ...base,
        ...retryPolicy(raw, path, issues),
        type: "shell",
        // 指令允許換行（多行腳本），其他文字欄位不允許控制字元。
        command: issues.text(raw.command, `${path}.command`, MAX_SHELL_LENGTH, { control: true }),
        timeoutSec: raw.timeoutSec === undefined ? DEFAULT_SHELL_TIMEOUT_SEC : issues.int(raw.timeoutSec, `${path}.timeoutSec`, 1, MAX_SHELL_TIMEOUT_SEC),
        env: (env ?? []).flatMap((item, index) => {
          if (!isRecord(item) || typeof item.name !== "string" || !ENV_NAME.test(item.name) || typeof item.value !== "string" || item.value.length > 2000 || CONTROL.test(item.value)) {
            issues.add(`${path}.env[${index + 1}]`, "名稱需為大寫英文、數字與底線，值不可含控制字元");
            return [];
          }
          if (isReservedEnvName(item.name)) {
            issues.add(`${path}.env[${index + 1}]`, `${item.name} 是保留的環境變數名稱，不能由規則設定`);
            return [];
          }
          return [{ name: item.name, value: item.value }];
        }),
        secretEnvNames: (secretNames ?? []).flatMap((name, index) => {
          if (typeof name !== "string" || !ENV_NAME.test(name)) {
            issues.add(`${path}.secretEnvNames[${index + 1}]`, "名稱需為大寫英文、數字與底線");
            return [];
          }
          if (isReservedEnvName(name)) {
            issues.add(`${path}.secretEnvNames[${index + 1}]`, `${name} 是保留的環境變數名稱，不能由規則設定`);
            return [];
          }
          return [name];
        })
      };
    }

    case "create_work_branch":
      return compact({
        ...base,
        type: "create_work_branch" as const,
        branchType: issues.optionalText(raw.branchType, `${path}.branchType`, 12),
        slug: issues.optionalText(raw.slug, `${path}.slug`, MAX_PATTERN_LENGTH)
      });

    case "notify_system":
      return compact({
        ...base,
        type: "notify_system" as const,
        title: issues.optionalText(raw.title, `${path}.title`, 200),
        body: issues.optionalText(raw.body, `${path}.body`, 1000)
      });

    case "notify_slack":
      return compact({ ...base, type: "notify_slack" as const, text: issues.optionalText(raw.text, `${path}.text`, 2000) });

    case "notify_webhook": {
      const url = issues.text(raw.url, `${path}.url`, 2000);
      if (url && !/^https?:\/\/[^\s/]+/i.test(url)) {
        issues.add(`${path}.url`, "需為 http:// 或 https:// 網址");
      }
      if (raw.includeEvent !== undefined && typeof raw.includeEvent !== "boolean") {
        issues.add(`${path}.includeEvent`, "需為 true 或 false");
      }
      return { ...base, type: "notify_webhook", url, includeEvent: raw.includeEvent !== false };
    }

    case "notify_email": {
      const to = issues.text(raw.to, `${path}.to`, 254);
      if (to && !SIMPLE_EMAIL.test(to)) {
        issues.add(`${path}.to`, "不是有效的電子郵件地址");
      }
      return compact({ ...base, type: "notify_email" as const, to, subject: issues.optionalText(raw.subject, `${path}.subject`, 200) });
    }
  }
};

export const validateRuleInput = (raw: unknown, path = "規則"): RuleValidation => {
  const issues = new Issues();
  if (!isRecord(raw)) {
    return { ok: false, errors: [`${path}：格式不正確`] };
  }

  const name = issues.text(raw.name, `${path}.名稱`, 200);
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    issues.add(`${path}.enabled`, "需為 true 或 false");
  }
  if (raw.skipConfirm !== undefined && typeof raw.skipConfirm !== "boolean") {
    issues.add(`${path}.skipConfirm`, "需為 true 或 false");
  }
  const matchMode = raw.matchMode === undefined ? "all" : raw.matchMode === "all" || raw.matchMode === "any" ? raw.matchMode : null;
  if (matchMode === null) {
    issues.add(`${path}.matchMode`, "需為 all 或 any");
  }

  const conditionsRaw = raw.conditions === undefined ? [] : Array.isArray(raw.conditions) && raw.conditions.length <= MAX_CONDITIONS ? raw.conditions : null;
  if (conditionsRaw === null) {
    issues.add(`${path}.conditions`, `最多 ${MAX_CONDITIONS} 個條件`);
  }
  const actionsRaw = Array.isArray(raw.actions) && raw.actions.length >= 1 && raw.actions.length <= MAX_ACTIONS ? raw.actions : null;
  if (actionsRaw === null) {
    issues.add(`${path}.actions`, `需要 1～${MAX_ACTIONS} 個動作`);
  }

  const conditions = (conditionsRaw ?? []).flatMap((item, index) => {
    const condition = validateCondition(item, `${path}.條件[${index + 1}]`, issues);
    return condition ? [condition] : [];
  });
  const actions = (actionsRaw ?? []).flatMap((item, index) => {
    const action = validateAction(item, `${path}.動作[${index + 1}]`, issues);
    return action ? [action] : [];
  });

  const priority = raw.priority === undefined ? DEFAULT_PRIORITY : issues.int(raw.priority, `${path}.priority`, -100000, 100000);
  const cooldownSec = raw.cooldownSec === undefined ? DEFAULT_COOLDOWN_SEC : issues.int(raw.cooldownSec, `${path}.cooldownSec`, 0, 86400);

  if (issues.list.length > 0) {
    return { ok: false, errors: issues.list };
  }
  return {
    ok: true,
    value: {
      name,
      enabled: raw.enabled !== false,
      priority,
      matchMode: matchMode ?? "all",
      conditions,
      actions,
      cooldownSec,
      skipConfirm: raw.skipConfirm === true
    }
  };
};

// ---------------------------------------------------------------------------
// 事件文字模板（通知、Slack 用；只做字串代換，絕不用在指令上）
// ---------------------------------------------------------------------------

export const EVENT_TEMPLATE_VARIABLES = ["project", "branch", "pusher", "message", "sha", "files", "commits", "type"] as const;

export const eventVariables = (event: PushEvent, project: Pick<Project, "name">): Record<string, string> => ({
  project: project.name,
  branch: event.branch,
  pusher: event.pusher ?? "",
  message: event.headMessage,
  sha: event.afterSha.slice(0, 7),
  files: String(event.fileCount),
  commits: String(event.commits.length),
  type: event.eventType
});

/** 把 {變數} 換成值；不認得的變數原樣保留。 */
export const expandEventText = (template: string, variables: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(variables, name) ? (variables[name] as string) : whole));
