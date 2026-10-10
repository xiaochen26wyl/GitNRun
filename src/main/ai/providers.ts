/**
 * AI 供應商的 HTTP 客戶端（直接用 fetch，不引入 SDK）。金鑰由呼叫端在使用當下從保險庫取出傳入，
 * 這裡不保存。錯誤只回報種類與 HTTP 狀態，不帶回應內容（回應可能回顯我們送出的程式碼片段）。
 */

export interface AiRequest {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
}

export interface AiResponse {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface AiClient {
  complete(request: AiRequest, apiKey: string): Promise<AiResponse>;
}

export type AiFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal }
) => Promise<{ status: number; json(): Promise<unknown> }>;

export type AiErrorKind = "auth" | "rate-limited" | "invalid" | "unavailable";

export class AiProviderError extends Error {
  readonly kind: AiErrorKind;
  readonly status: number | null;

  constructor(kind: AiErrorKind, status: number | null = null) {
    super(`ai provider error: ${kind}${status === null ? "" : ` (HTTP ${status})`}`);
    this.name = "AiProviderError";
    this.kind = kind;
    this.status = status;
  }
}

export const AI_REQUEST_TIMEOUT_MS = 60_000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

const classify = (status: number): AiProviderError => {
  if (status === 401 || status === 403) return new AiProviderError("auth", status);
  if (status === 429) return new AiProviderError("rate-limited", status);
  if (status >= 500) return new AiProviderError("unavailable", status);
  return new AiProviderError("invalid", status);
};

const post = async (fetchFn: AiFetch, url: string, headers: Record<string, string>, body: unknown): Promise<unknown> => {
  let response: Awaited<ReturnType<AiFetch>>;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS)
    });
  } catch {
    throw new AiProviderError("unavailable");
  }
  if (response.status < 200 || response.status >= 300) {
    throw classify(response.status);
  }
  try {
    return await response.json();
  } catch {
    throw new AiProviderError("invalid", response.status);
  }
};

export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

export const createAnthropicClient = (fetchFn: AiFetch): AiClient => ({
  async complete(request, apiKey) {
    const body = await post(
      fetchFn,
      ANTHROPIC_URL,
      { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      {
        model: request.model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: [{ role: "user", content: request.user }]
      }
    );
    if (!isRecord(body) || !Array.isArray(body.content)) {
      throw new AiProviderError("invalid");
    }
    const text = body.content
      .flatMap((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []))
      .join("");
    const usage = isRecord(body.usage) ? body.usage : {};
    return { text, inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens) };
  }
});

export const createOpenAiClient = (fetchFn: AiFetch): AiClient => ({
  async complete(request, apiKey) {
    const body = await post(
      fetchFn,
      OPENAI_URL,
      { Authorization: `Bearer ${apiKey}` },
      {
        model: request.model,
        max_completion_tokens: request.maxTokens,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user }
        ]
      }
    );
    const choice = isRecord(body) && Array.isArray(body.choices) ? body.choices[0] : undefined;
    const message = isRecord(choice) && isRecord(choice.message) ? choice.message : undefined;
    if (!message || typeof message.content !== "string") {
      throw new AiProviderError("invalid");
    }
    const usage = isRecord(body) && isRecord(body.usage) ? body.usage : {};
    return { text: message.content, inputTokens: count(usage.prompt_tokens), outputTokens: count(usage.completion_tokens) };
  }
});
