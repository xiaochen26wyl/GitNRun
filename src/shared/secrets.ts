/**
 * 密鑰的共用型別與命名規則（純函式，渲染層可引用）。
 * 渲染層永遠只看得到「狀態」，看不到明文，也看不到密文。
 */

export const FIXED_SECRET_NAMES = [
  "github.pat",
  "ai.anthropic",
  "ai.openai",
  "notify.slack_webhook",
  "smtp.password"
] as const;

export type FixedSecretName = (typeof FIXED_SECRET_NAMES)[number];

export const SECRET_LABELS: Record<FixedSecretName, string> = {
  "github.pat": "GitHub Token（fine-grained：Issues: Read、Metadata: Read；監視推送另需 Contents: Read）",
  "ai.anthropic": "Anthropic API Key",
  "ai.openai": "OpenAI API Key",
  "notify.slack_webhook": "Slack Incoming Webhook URL",
  "smtp.password": "SMTP 密碼"
};

const WEBHOOK_SECRET_NAME = /^webhook\.secret\.\d{1,9}$/;
const RULE_ENV_SECRET_NAME = /^env\.\d{1,9}\.[A-Z_][A-Z0-9_]{0,63}$/;
/** 專案啟動頁每個目標的 dev 通關密碼：devpass.p3（專案）、devpass.f2（自己加入的資料夾）。 */
const RUN_PASSCODE_SECRET_NAME = /^devpass\.[pf][1-9]\d{0,8}$/;

export const isFixedSecretName = (value: unknown): value is FixedSecretName =>
  typeof value === "string" && (FIXED_SECRET_NAMES as readonly string[]).includes(value);

/** 固定名稱、每專案 Webhook 簽章 secret、規則的敏感環境變數、專案啟動頁的 dev 通關密碼，其餘一律不是合法名稱。 */
export const isSecretName = (value: unknown): value is string =>
  isFixedSecretName(value) ||
  (typeof value === "string" &&
    (WEBHOOK_SECRET_NAME.test(value) || RULE_ENV_SECRET_NAME.test(value) || RUN_PASSCODE_SECRET_NAME.test(value)));

export const MAX_SECRET_LENGTH = 4096;

export type SecretState = "ok" | "unreadable" | "missing";

export interface SecretStatus {
  name: string;
  configured: boolean;
  state: SecretState;
  /** 末四碼（值太短時為空字串），僅供辨識是哪一把金鑰。 */
  hint: string;
  updatedAt: number | null;
}

export interface SecretsOverview {
  /** 作業系統是否能保護金鑰；false 時所有儲存動作都會被拒絕。 */
  available: boolean;
  secrets: SecretStatus[];
}

export interface SecretTestResult {
  ok: boolean;
  message: string;
  warnings: string[];
}

/** UI 顯示用的遮罩前綴；渲染層把遮罩值回送時視為「未變更」。 */
export const MASK_PREFIX = "••••";

export const isMaskedPlaceholder = (value: string): boolean => value.startsWith(MASK_PREFIX);

export const maskedDisplay = (status: SecretStatus): string =>
  status.configured ? `${MASK_PREFIX}${status.hint}` : "";
