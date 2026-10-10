import {
  DEFAULT_GIT_TIMEOUT_SEC,
  DEFAULT_RETRIES,
  DEFAULT_RETRY_DELAY_SEC,
  DEFAULT_COOLDOWN_SEC,
  DEFAULT_PRIORITY,
  DEFAULT_SHELL_TIMEOUT_SEC,
  type ActionType,
  type ConditionType,
  type EnvVar,
  type RuleAction,
  type RuleCondition,
  type RuleInput
} from "@shared/rules";

/** 規則編輯器用的預設值與文字轉換（純函式）。 */

export const emptyRule = (): RuleInput => ({
  name: "",
  enabled: true,
  priority: DEFAULT_PRIORITY,
  matchMode: "all",
  conditions: [],
  actions: [{ type: "notify_system" }],
  cooldownSec: DEFAULT_COOLDOWN_SEC,
  skipConfirm: false
});

/** 新增條件時的起始內容；需要使用者填的欄位留空，儲存時由驗證指出。 */
export const defaultCondition = (type: ConditionType): RuleCondition => {
  switch (type) {
    case "branch":
      return { type, patterns: ["main"] };
    case "file":
      return { type, patterns: ["*.md"] };
    case "pusher":
      return { type, names: [] };
    case "time":
      return { type, from: "09:00", to: "18:00", days: [1, 2, 3, 4, 5], match: "inside" };
    case "file_count":
      return { type, op: "gte", value: 10 };
    case "branch_violation":
      return { type, value: true };
    case "event_type":
      return { type, types: ["push", "create"] };
    case "project":
      return { type, projectIds: [] };
  }
};

export const defaultAction = (type: ActionType): RuleAction => {
  switch (type) {
    case "ai_commit_message":
    case "ai_summary":
    case "notify_system":
    case "notify_slack":
    case "create_work_branch":
      return { type };
    case "notify_webhook":
      return { type, url: "", includeEvent: true };
    case "notify_email":
      return { type, to: "" };
    case "git":
      return { type, command: "fetch", args: ["origin"], timeoutSec: DEFAULT_GIT_TIMEOUT_SEC, retries: DEFAULT_RETRIES, retryDelaySec: DEFAULT_RETRY_DELAY_SEC };
    case "shell":
      return {
        type,
        command: "",
        timeoutSec: DEFAULT_SHELL_TIMEOUT_SEC,
        env: [],
        secretEnvNames: [],
        retries: DEFAULT_RETRIES,
        retryDelaySec: DEFAULT_RETRY_DELAY_SEC
      };
  }
};

/** 多行文字 → 清單（去掉空白行與前後空白）。 */
export const linesToList = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

export const listToLines = (list: readonly string[]): string => list.join("\n");

/** "NAME=value" 每行一組；值裡可以再有 "="。沒有 "=" 的行視為值為空。 */
export const parseEnvLines = (text: string): EnvVar[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const at = line.indexOf("=");
      return at === -1 ? { name: line, value: "" } : { name: line.slice(0, at).trim(), value: line.slice(at + 1) };
    });

export const envToLines = (env: readonly EnvVar[]): string => env.map((item) => `${item.name}=${item.value}`).join("\n");

/** 逗號或換行分隔的名稱清單。 */
export const parseNameList = (text: string): string[] =>
  text
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

/** 把兩個項目對調（排序按鈕用）；超出範圍就原樣回傳。 */
export const moveItem = <T>(list: readonly T[], index: number, direction: -1 | 1): T[] => {
  const target = index + direction;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) {
    return [...list];
  }
  const next = [...list];
  [next[index], next[target]] = [next[target] as T, next[index] as T];
  return next;
};
