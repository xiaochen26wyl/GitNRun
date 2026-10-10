/** Webhook 選配模式的共用型別與設定驗證（純函式）。 */

export const WEBHOOK_HOST = "127.0.0.1";
export const DEFAULT_WEBHOOK_PORT = 8765;
export const MIN_WEBHOOK_PORT = 1024;
export const MAX_WEBHOOK_PORT = 65535;
/** 請求內容大小上限；超過直接拒絕。 */
export const MAX_WEBHOOK_BODY_BYTES = 5 * 1024 * 1024;

export interface WebhookSettings {
  /** 預設關閉。開啟才會在本機啟動接收端。 */
  enabled: boolean;
  port: number;
  /** 使用者自備隧道（ngrok、cloudflared）的公開網址，只用來顯示 payload URL。 */
  publicBaseUrl: string | null;
}

export const DEFAULT_WEBHOOK_SETTINGS: WebhookSettings = {
  enabled: false,
  port: DEFAULT_WEBHOOK_PORT,
  publicBaseUrl: null
};

export type WebhookSettingsValidation = { ok: true; value: WebhookSettings } | { ok: false; errors: string[] };

export const validateWebhookSettings = (raw: unknown): WebhookSettingsValidation => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["輸入格式不正確"] };
  }
  const input = { ...DEFAULT_WEBHOOK_SETTINGS, ...(raw as Record<string, unknown>) };
  const errors: string[] = [];

  if (typeof input.enabled !== "boolean") errors.push("啟用狀態不正確");
  if (typeof input.port !== "number" || !Number.isSafeInteger(input.port) || input.port < MIN_WEBHOOK_PORT || input.port > MAX_WEBHOOK_PORT) {
    errors.push(`連接埠需介於 ${MIN_WEBHOOK_PORT} 到 ${MAX_WEBHOOK_PORT}`);
  }

  let publicBaseUrl: string | null = null;
  if (input.publicBaseUrl !== null && input.publicBaseUrl !== "") {
    const normalized = typeof input.publicBaseUrl === "string" ? normalizePublicBaseUrl(input.publicBaseUrl) : null;
    if (normalized === null) {
      errors.push("公開網址需為 https:// 開頭的網址（不含帳號密碼）");
    } else {
      publicBaseUrl = normalized;
    }
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: { enabled: input.enabled as boolean, port: input.port as number, publicBaseUrl } };
};

/** 隧道的公開網址：只收 https，去掉結尾斜線，不接受帳號密碼、query、fragment。 */
export const normalizePublicBaseUrl = (raw: string): string | null => {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
      return null;
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
};

export const WEBHOOK_PATH_PREFIX = "/hook/";

export const payloadPath = (projectId: number): string => `${WEBHOOK_PATH_PREFIX}${projectId}`;

export const buildPayloadUrl = (publicBaseUrl: string | null, projectId: number): string | null =>
  publicBaseUrl === null ? null : `${publicBaseUrl}${payloadPath(projectId)}`;

export interface WebhookStatus {
  enabled: boolean;
  listening: boolean;
  port: number;
  /** 啟動失敗的原因（如連接埠被占用）。 */
  error: string | null;
}

export interface ProjectWebhookInfo {
  projectId: number;
  /** 公開網址尚未設定時為 null。 */
  payloadUrl: string | null;
  secretConfigured: boolean;
  lastReceivedAt: number | null;
}
