import { safeStorage } from "electron";
import type { SecretCipher } from "@main/vault/vault";

/**
 * Electron safeStorage：macOS 上加密金鑰由 Keychain 持有，密文只能在同一個登入帳號、
 * 同一個 app 身分下解開。未簽章版本更新後 Keychain 可能再次要求授權。
 */
export const safeStorageCipher: SecretCipher = {
  isAvailable: () => {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  },
  encrypt: (plain) => safeStorage.encryptString(plain).toString("base64"),
  decrypt: (stored) => safeStorage.decryptString(Buffer.from(stored, "base64"))
};
