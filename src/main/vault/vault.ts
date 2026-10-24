import {
  FIXED_SECRET_NAMES,
  MAX_SECRET_LENGTH,
  isSecretName,
  type SecretStatus,
  type SecretsOverview
} from "@shared/secrets";
import type { Db } from "@main/db/database";

/**
 * 密鑰保險庫：全 app 唯一能存取密鑰的出入口，只存在於主程序。
 *
 * - 密文存 api_keys 表；加密由注入的 SecretCipher 負責（正式環境是 Keychain 金鑰的 AES-GCM，
 *   金鑰由 macOS Keychain 持有）。
 * - 加密不可用時一律拒絕儲存，絕不退回明文。
 * - 沒有任何方法會把明文或密文交給呼叫端保存：讀取只能透過 useSecret，
 *   明文只活在回呼的執行期間，不快取。
 * - 渲染層只看得到 SecretStatus（是否已設定、末四碼、是否可讀）。
 */

export interface SecretCipher {
  isAvailable(): boolean;
  /** 回傳可存進資料庫的字串（base64）。 */
  encrypt(plain: string): string;
  /** 無法解密時必須丟出例外。 */
  decrypt(stored: string): string;
}

export class VaultUnavailableError extends Error {
  constructor() {
    super("secret storage is unavailable on this machine");
    this.name = "VaultUnavailableError";
  }
}

export class InvalidSecretError extends Error {
  constructor(reason: string) {
    super(`invalid secret: ${reason}`);
    this.name = "InvalidSecretError";
  }
}

export class SecretMissingError extends Error {
  readonly secretName: string;

  constructor(secretName: string) {
    super(`secret is not configured: ${secretName}`);
    this.name = "SecretMissingError";
    this.secretName = secretName;
  }
}

export class SecretUnreadableError extends Error {
  readonly secretName: string;

  constructor(secretName: string) {
    super(`secret could not be decrypted, please enter it again: ${secretName}`);
    this.name = "SecretUnreadableError";
    this.secretName = secretName;
  }
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MIN_LENGTH_FOR_HINT = 12;

/** 末四碼，只用來辨識是哪一把；太短的值不透露任何字元。 */
export const secretHint = (value: string): string =>
  value.length >= MIN_LENGTH_FOR_HINT ? value.slice(-4) : "";

export interface Vault {
  isAvailable(): boolean;
  set(name: string, value: string): SecretStatus;
  delete(name: string): void;
  has(name: string): boolean;
  getStatus(name: string): SecretStatus;
  overview(): SecretsOverview;
  /** 明文只在回呼執行期間存在；回呼之外不要保留它。 */
  useSecret<T>(name: string, fn: (secret: string) => T | Promise<T>): Promise<T>;
}

const missingStatus = (name: string): SecretStatus => ({
  name,
  configured: false,
  state: "missing",
  hint: "",
  updatedAt: null
});

export const createVault = (db: Db, cipher: SecretCipher, clock: () => number = Date.now): Vault => {
  const assertName = (name: string): void => {
    if (!isSecretName(name)) {
      throw new InvalidSecretError("unknown secret name");
    }
  };

  const readRow = (name: string): Record<string, unknown> | undefined =>
    db.prepare("SELECT name, ciphertext, hint, updated_at FROM api_keys WHERE name = ?").get(name);

  const statusFromRow = (row: Record<string, unknown>): SecretStatus => {
    let state: SecretStatus["state"] = "ok";
    try {
      cipher.decrypt(String(row.ciphertext));
    } catch {
      // 例如 Keychain 被重設、換了登入帳號、複製了別台機器的資料庫。
      state = "unreadable";
    }
    return {
      name: String(row.name),
      configured: true,
      state,
      hint: String(row.hint),
      updatedAt: Number(row.updated_at)
    };
  };

  const getStatus = (name: string): SecretStatus => {
    assertName(name);
    const row = readRow(name);
    return row ? statusFromRow(row) : missingStatus(name);
  };

  return {
    isAvailable: () => cipher.isAvailable(),

    set(name, value) {
      assertName(name);
      if (typeof value !== "string" || value.length === 0 || value.length > MAX_SECRET_LENGTH) {
        throw new InvalidSecretError("empty or too long");
      }
      if (CONTROL_CHARACTERS.test(value)) {
        throw new InvalidSecretError("control characters are not allowed");
      }
      if (!cipher.isAvailable()) {
        throw new VaultUnavailableError();
      }

      const now = clock();
      db.prepare(
        `INSERT INTO api_keys (name, ciphertext, hint, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           ciphertext = excluded.ciphertext, hint = excluded.hint, updated_at = excluded.updated_at`
      ).run(name, cipher.encrypt(value), secretHint(value), now, now);
      return getStatus(name);
    },

    delete(name) {
      assertName(name);
      db.prepare("DELETE FROM api_keys WHERE name = ?").run(name);
    },

    has(name) {
      assertName(name);
      return readRow(name) !== undefined;
    },

    getStatus,

    overview() {
      const stored = new Map<string, SecretStatus>(
        db
          .prepare("SELECT name, ciphertext, hint, updated_at FROM api_keys ORDER BY name")
          .all()
          .map((row) => [String(row.name), statusFromRow(row)])
      );
      const fixed = FIXED_SECRET_NAMES.map((name) => stored.get(name) ?? missingStatus(name));
      const dynamic = [...stored.values()].filter(
        (status) => !(FIXED_SECRET_NAMES as readonly string[]).includes(status.name)
      );
      return { available: cipher.isAvailable(), secrets: [...fixed, ...dynamic] };
    },

    async useSecret(name, fn) {
      assertName(name);
      const row = readRow(name);
      if (!row) {
        throw new SecretMissingError(name);
      }
      let plain: string;
      try {
        plain = cipher.decrypt(String(row.ciphertext));
      } catch {
        throw new SecretUnreadableError(name);
      }
      return fn(plain);
    }
  };
};
