import type { Db } from "@main/db/database";
import { createVault, type SecretCipher, type Vault } from "@main/vault/vault";

let vault: Vault | null = null;

/** 加密方式由外殼決定（Electron 的 safeStorage、Tauri 的 Keychain 金鑰）；必須在外殼準備好之後呼叫。 */
export const initVault = (db: Db, cipher: SecretCipher): Vault => {
  vault = createVault(db, cipher);
  return vault;
};

export const getVault = (): Vault => {
  if (!vault) {
    throw new Error("vault is not initialised");
  }
  return vault;
};
