import type { SecretTestResult } from "@shared/secrets";

/**
 * GitHub token 的「測試連線」與權限評估。
 * 監視只需要讀取（Contents: Read、Metadata: Read）；本機 push 用的是使用者自己的 git 憑證，
 * 所以這把 token 不需要任何寫入權限，權限過寬時要明確警示。
 */

export type GithubTokenKind = "fine-grained" | "classic" | "unknown";

export interface TokenAssessment {
  kind: GithubTokenKind;
  scopes: string[];
  warnings: string[];
}

const WRITE_SCOPE = /^(repo|delete_repo|workflow|write:.+|admin:.+)$/;

export const assessGithubToken = (token: string, scopesHeader: string | null): TokenAssessment => {
  const scopes = (scopesHeader ?? "")
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
  const warnings: string[] = [];

  if (token.startsWith("github_pat_")) {
    warnings.push("GitHub 不會透過 API 揭露 fine-grained token 的細部權限，請確認只授予 Contents: Read 與 Metadata: Read。");
    return { kind: "fine-grained", scopes, warnings };
  }

  const isClassic = scopesHeader !== null || token.startsWith("ghp_");
  if (!isClassic) {
    return { kind: "unknown", scopes, warnings };
  }

  const broad = scopes.filter((scope) => WRITE_SCOPE.test(scope));
  if (broad.length > 0) {
    warnings.push(
      `這是 classic token，且包含寫入／管理權限（${broad.join("、")}）。監視只需要讀取，建議改用 fine-grained token（僅 Contents: Read、Metadata: Read）。`
    );
  } else {
    warnings.push("這是 classic token；建議改用 fine-grained token 以縮小可存取的範圍。");
  }
  return { kind: "classic", scopes, warnings };
};

export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal?: AbortSignal }
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

const GITHUB_USER_URL = "https://api.github.com/user";
const REQUEST_TIMEOUT_MS = 10_000;

/** 用 GET /user 驗證 token；錯誤訊息只含 HTTP 狀態，不回傳任何標頭或 token。 */
export const testGithubToken = async (token: string, fetchFn: FetchFn): Promise<SecretTestResult> => {
  let response: Awaited<ReturnType<FetchFn>>;
  try {
    response = await fetchFn(GITHUB_USER_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "gitnrun"
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch {
    return { ok: false, message: "無法連線到 GitHub，請檢查網路。", warnings: [] };
  }

  if (response.status === 401) {
    return { ok: false, message: "Token 無效或已過期（401）。", warnings: [] };
  }
  if (response.status === 403) {
    return { ok: false, message: "Token 被拒絕或已達 rate limit（403）。", warnings: [] };
  }
  if (response.status !== 200) {
    return { ok: false, message: `GitHub 回應 HTTP ${response.status}。`, warnings: [] };
  }

  const assessment = assessGithubToken(token, response.headers.get("x-oauth-scopes"));
  let login = "";
  try {
    const body = (await response.json()) as { login?: unknown };
    login = typeof body.login === "string" ? body.login : "";
  } catch {
    // 登入名稱只是顯示用，取不到不影響結果。
  }
  return {
    ok: true,
    message: login ? `連線成功，帳號：${login}` : "連線成功。",
    warnings: assessment.warnings
  };
};
