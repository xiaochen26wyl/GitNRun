import type { Db } from "@main/db/database";
import { safeStorageCipher } from "@main/vault/safe-storage-cipher";
import { createVault, type Vault } from "@main/vault/vault";

let vault: Vault | null = null;

/** 必須在 app ready 之後呼叫（safeStorage 在 ready 之前不可用）。 */
export const initVault = (db: Db): Vault => {
  vault = createVault(db, safeStorageCipher);
  return vault;
};

export const getVault = (): Vault => {
  if (!vault) {
    throw new Error("vault is not initialised");
  }
  return vault;
};
