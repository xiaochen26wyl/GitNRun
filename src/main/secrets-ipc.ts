import { IPC } from "@shared/ipc";
import type { FetchFn } from "@main/github-token-check";
import { handleIpc } from "@main/ipc";
import { asNoArgs, asSecretNameArgs, asSecretSetArgs } from "@main/ipc-validation";
import { testSecret, type AiPinger } from "@main/secret-test";
import { InvalidSecretError, VaultUnavailableError, type Vault } from "@main/vault/vault";

/** 把保險庫的錯誤轉成使用者看得懂、且不含任何金鑰內容的訊息。 */
const toUserFacingError = (error: unknown): Error => {
  if (error instanceof VaultUnavailableError) {
    return new Error("此電腦無法使用系統金鑰保護，為了安全已拒絕儲存金鑰。");
  }
  if (error instanceof InvalidSecretError) {
    return new Error("金鑰格式不正確。");
  }
  return new Error("金鑰操作失敗。");
};

export const registerSecretsIpc = (vault: Vault, options: { fetchFn?: FetchFn; ai?: AiPinger } = {}): void => {
  const fetchFn = options.fetchFn ?? fetch;
  handleIpc(IPC.secretsOverview, asNoArgs, () => vault.overview());

  handleIpc(IPC.secretsSet, asSecretSetArgs, (name, input) => {
    if (input.kind === "unchanged") {
      return vault.getStatus(name);
    }
    try {
      return vault.set(name, input.value);
    } catch (error) {
      throw toUserFacingError(error);
    }
  });

  handleIpc(IPC.secretsDelete, asSecretNameArgs, (name) => {
    vault.delete(name);
  });

  handleIpc(IPC.secretsTest, asSecretNameArgs, (name) => testSecret(vault, name, fetchFn, options.ai));
};
