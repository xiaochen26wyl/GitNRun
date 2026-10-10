import type { AiProvider } from "@shared/ai";
import type { SecretTestResult } from "@shared/secrets";
import { testGithubToken, type FetchFn } from "@main/github-token-check";
import { SecretMissingError, SecretUnreadableError, type Vault } from "@main/vault/vault";

export interface AiPinger {
  ping(provider: AiProvider): Promise<{ ok: boolean; message: string }>;
}

const AI_KEYS: Record<string, AiProvider> = { "ai.anthropic": "anthropic", "ai.openai": "openai" };

/** 「測試連線」：GitHub token，以及（有提供 AI 服務時）Anthropic／OpenAI 金鑰。 */
export const testSecret = async (vault: Vault, name: string, fetchFn: FetchFn, ai?: AiPinger): Promise<SecretTestResult> => {
  const provider = AI_KEYS[name];
  if (provider && ai) {
    const result = await ai.ping(provider);
    return { ok: result.ok, message: result.message, warnings: [] };
  }
  if (name !== "github.pat") {
    return { ok: false, message: "這把金鑰目前不支援測試連線。", warnings: [] };
  }
  try {
    return await vault.useSecret(name, (token) => testGithubToken(token, fetchFn));
  } catch (error) {
    if (error instanceof SecretMissingError) {
      return { ok: false, message: "尚未設定。", warnings: [] };
    }
    if (error instanceof SecretUnreadableError) {
      return { ok: false, message: "無法解密已存的金鑰，請重新輸入。", warnings: [] };
    }
    return { ok: false, message: "測試失敗。", warnings: [] };
  }
};
