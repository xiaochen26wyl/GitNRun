import type { SecretCipher } from "@main/vault/vault";

export interface FakeCipher extends SecretCipher {
  available: boolean;
  /** 之後解密這些密文會失敗，模擬 Keychain 被重設或換了登入帳號。 */
  brokenCiphertexts: Set<string>;
}

/** 可逆但看起來像密文的假加密器，測試用。 */
export const createFakeCipher = (): FakeCipher => {
  const cipher: FakeCipher = {
    available: true,
    brokenCiphertexts: new Set(),
    isAvailable: () => cipher.available,
    encrypt: (plain) => Buffer.from(`ENC1:${[...plain].reverse().join("")}`).toString("base64"),
    decrypt: (stored) => {
      if (cipher.brokenCiphertexts.has(stored)) {
        throw new Error("cannot decrypt");
      }
      const decoded = Buffer.from(stored, "base64").toString("utf8");
      if (!decoded.startsWith("ENC1:")) {
        throw new Error("not ciphertext");
      }
      return [...decoded.slice("ENC1:".length)].reverse().join("");
    }
  };
  return cipher;
};
