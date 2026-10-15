import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SecretCipher } from "@main/vault/vault";

/**
 * 保險庫在 Tauri 外殼下的加密：AES-256-GCM，主金鑰由外殼存在 macOS Keychain，
 * 啟動時交給核心，只活在這個閉包裡（不落地、不記錄）。
 *
 * 密文格式：`gnr2:` + base64(iv 12 位元組 | 驗證標籤 16 位元組 | 密文)。
 * 舊版 Electron safeStorage 的密文沒有這個前綴，一律拒絕解密，保險庫會把它顯示成「需重新輸入」。
 */

export const CIPHER_PREFIX = "gnr2:";
export const MASTER_KEY_BYTES = 32;

const IV_BYTES = 12;
const TAG_BYTES = 16;
const ALGORITHM = "aes-256-gcm";
/** 綁定用途：換成別的情境產生的密文不會被誤收。 */
const AAD = Buffer.from("gitnrun.vault.v2");

/** masterKey 為 null 或長度不對時，加密視為不可用（保險庫拒絕儲存，絕不退回明文）。 */
export const createAesGcmCipher = (masterKey: Buffer | null): SecretCipher => {
  const key = masterKey !== null && masterKey.length === MASTER_KEY_BYTES ? Buffer.from(masterKey) : null;

  const requireKey = (): Buffer => {
    if (key === null) {
      throw new Error("secret key is unavailable");
    }
    return key;
  };

  return {
    isAvailable: () => key !== null,

    encrypt(plain) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, requireKey(), iv);
      cipher.setAAD(AAD);
      const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return CIPHER_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
    },

    decrypt(stored) {
      if (!stored.startsWith(CIPHER_PREFIX)) {
        throw new Error("unsupported ciphertext format");
      }
      const data = Buffer.from(stored.slice(CIPHER_PREFIX.length), "base64");
      if (data.length < IV_BYTES + TAG_BYTES) {
        throw new Error("ciphertext is truncated");
      }
      const decipher = createDecipheriv(ALGORITHM, requireKey(), data.subarray(0, IV_BYTES));
      decipher.setAAD(AAD);
      decipher.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return Buffer.concat([decipher.update(data.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
    }
  };
};

/** 外殼用 base64 傳主金鑰；格式不對或長度不是 32 位元組就視為沒有金鑰。 */
export const decodeMasterKey = (value: unknown): Buffer | null => {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.length === MASTER_KEY_BYTES ? decoded : null;
};
