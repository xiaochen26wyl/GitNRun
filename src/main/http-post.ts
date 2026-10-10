/** 對外送出 JSON 的最小原語（Slack、外送 Webhook 用）。 */

export interface PostResult {
  status: number;
}

export type PostJsonFn = (url: string, body: unknown) => Promise<PostResult>;

const POST_TIMEOUT_MS = 10_000;

/**
 * 不跟隨重新導向：目標網址是使用者設定的，被導去別的主機就代表不是使用者預期的地方。
 * 丟出的錯誤不含網址（網址的 query 可能帶有憑證），呼叫端只報固定訊息。
 */
export const postJson: PostJsonFn = async (url, body) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "gitnrun" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(POST_TIMEOUT_MS)
  });
  return { status: response.status };
};
