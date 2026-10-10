import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * 驗證 GitHub 的 X-Hub-Signature-256：以「原始請求內容」計算 HMAC-SHA256，
 * 用恆定時間比較。標頭缺少、格式不對、長度不對都一律視為驗證失敗。
 */

const SIGNATURE = /^sha256=([0-9a-f]{64})$/i;

export const computeSignature = (secret: string, rawBody: Buffer): string =>
  `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;

export const verifySignature = (secret: string, rawBody: Buffer, header: string | undefined): boolean => {
  if (secret.length === 0 || typeof header !== "string") {
    return false;
  }
  const match = SIGNATURE.exec(header.trim());
  if (!match?.[1]) {
    return false;
  }
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const received = Buffer.from(match[1], "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
};
