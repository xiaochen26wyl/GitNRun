import type { ChangedFile, ChangedFileStatus, CommitSummary } from "@shared/events";
import { isRepoPart } from "@shared/projects";
import type { FetchFn } from "@main/github-token-check";
import { SecretMissingError, SecretUnreadableError } from "@main/vault/vault";

/**
 * GitHub REST 客戶端（只讀）。fetch 與取得 token 的方式都由外部注入：
 * token 透過 withToken 回呼取得，明文只活在單次請求內，不會被客戶端保存。
 */

export type GithubErrorKind = "auth" | "forbidden" | "not-found" | "rate-limited" | "server" | "network" | "invalid";

export class GithubApiError extends Error {
  readonly kind: GithubErrorKind;
  readonly status: number | null;
  /** 被限流時建議等待多久（毫秒）。 */
  readonly retryAfterMs: number | null;

  constructor(kind: GithubErrorKind, status: number | null = null, retryAfterMs: number | null = null) {
    super(`github api error: ${kind}${status === null ? "" : ` (HTTP ${status})`}`);
    this.name = "GithubApiError";
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface RateLimitInfo {
  remaining: number | null;
  /** epoch ms */
  resetAt: number | null;
}

export interface BranchHead {
  name: string;
  sha: string;
}

export type BranchListResult =
  | { kind: "not-modified" }
  | {
      kind: "ok";
      branches: BranchHead[];
      /** 只有單頁結果才回傳；多頁時無法用單一 ETag 保證整份清單沒變，所以不提供。 */
      etag: string | null;
      /** 分頁數量超過上限而被截斷。 */
      truncated: boolean;
    };

export interface CompareResult {
  commits: CommitSummary[];
  files: ChangedFile[];
  totalCommits: number;
}

export interface GithubClientDeps {
  fetchFn: FetchFn;
  withToken: <T>(fn: (token: string) => Promise<T>) => Promise<T>;
  onRateLimit?: (info: RateLimitInfo) => void;
  baseUrl?: string;
  now?: () => number;
}

export interface GithubClient {
  getDefaultBranch(owner: string, repo: string): Promise<string>;
  listBranches(owner: string, repo: string, etag?: string | null): Promise<BranchListResult>;
  compare(owner: string, repo: string, base: string, head: string): Promise<CompareResult>;
  getCommit(owner: string, repo: string, sha: string): Promise<CommitSummary & { files: ChangedFile[] }>;
}

const DEFAULT_BASE_URL = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 15_000;
const BRANCHES_PER_PAGE = 100;
const MAX_BRANCH_PAGES = 20;
const MAX_STORED_COMMITS = 50;
const MAX_STORED_FILES = 300;
const MAX_COMMIT_MESSAGE = 1000;
const SHA_PATTERN = /^[0-9a-f]{7,64}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string => (typeof value === "string" ? value : "");

const mapFileStatus = (status: string): ChangedFileStatus => {
  switch (status) {
    case "added":
    case "copied":
      return "added";
    case "removed":
      return "removed";
    case "renamed":
      return "renamed";
    default:
      return "modified";
  }
};

const parseCommit = (raw: unknown): CommitSummary | null => {
  if (!isRecord(raw) || typeof raw.sha !== "string") {
    return null;
  }
  const commit = isRecord(raw.commit) ? raw.commit : {};
  const author = isRecord(commit.author) ? commit.author : {};
  const committer = isRecord(commit.committer) ? commit.committer : {};
  const authorUser = isRecord(raw.author) ? raw.author : {};
  const timestamp = Date.parse(str(committer.date) || str(author.date));
  return {
    sha: raw.sha,
    message: str(commit.message).slice(0, MAX_COMMIT_MESSAGE),
    author: str(authorUser.login) || str(author.name) || "unknown",
    timestamp: Number.isFinite(timestamp) ? timestamp : 0
  };
};

const parseFiles = (raw: unknown): ChangedFile[] =>
  (Array.isArray(raw) ? raw : []).slice(0, MAX_STORED_FILES).flatMap((item) => {
    if (!isRecord(item) || typeof item.filename !== "string") {
      return [];
    }
    const file: ChangedFile = { path: item.filename, status: mapFileStatus(str(item.status)) };
    if (typeof item.previous_filename === "string") {
      file.previousPath = item.previous_filename;
    }
    return [file];
  });

const nextLink = (linkHeader: string | null): boolean => linkHeader !== null && /<[^>]+>;\s*rel="next"/.test(linkHeader);

export const createGithubClient = (deps: GithubClientDeps): GithubClient => {
  const baseUrl = deps.baseUrl ?? DEFAULT_BASE_URL;
  const now = deps.now ?? Date.now;

  const reportRateLimit = (headers: { get(name: string): string | null }): void => {
    if (!deps.onRateLimit) {
      return;
    }
    const remaining = headers.get("x-ratelimit-remaining");
    const reset = headers.get("x-ratelimit-reset");
    deps.onRateLimit({
      remaining: remaining === null ? null : Number(remaining),
      resetAt: reset === null ? null : Number(reset) * 1000
    });
  };

  const retryAfterMs = (headers: { get(name: string): string | null }): number | null => {
    const retryAfter = headers.get("retry-after");
    if (retryAfter !== null && Number.isFinite(Number(retryAfter))) {
      return Number(retryAfter) * 1000;
    }
    const reset = headers.get("x-ratelimit-reset");
    if (reset !== null && Number.isFinite(Number(reset))) {
      return Math.max(Number(reset) * 1000 - now(), 0);
    }
    return null;
  };

  interface RawResponse {
    status: number;
    headers: { get(name: string): string | null };
    body: unknown;
  }

  const get = async (path: string, etag?: string | null): Promise<RawResponse> => {
    let response: Awaited<ReturnType<FetchFn>>;
    try {
      response = await deps.withToken((token) =>
        deps.fetchFn(`${baseUrl}${path}`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "gitnrun",
            ...(etag ? { "If-None-Match": etag } : {})
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        })
      );
    } catch (error) {
      // 保險庫的錯誤（未設定／無法解密）原樣往上拋，讓上層區分「沒有 token」與「網路問題」。
      if (error instanceof SecretMissingError || error instanceof SecretUnreadableError) {
        throw error;
      }
      throw new GithubApiError("network");
    }

    reportRateLimit(response.headers);
    const { status } = response;

    if (status === 304) {
      return { status, headers: response.headers, body: null };
    }
    if (status === 401) {
      throw new GithubApiError("auth", status);
    }
    if (status === 403 || status === 429) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      if (status === 429 || remaining === "0" || response.headers.get("retry-after") !== null) {
        throw new GithubApiError("rate-limited", status, retryAfterMs(response.headers));
      }
      throw new GithubApiError("forbidden", status);
    }
    if (status === 404) {
      throw new GithubApiError("not-found", status);
    }
    if (status >= 500) {
      throw new GithubApiError("server", status);
    }
    if (status !== 200) {
      throw new GithubApiError("invalid", status);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new GithubApiError("invalid", status);
    }
    return { status, headers: response.headers, body };
  };

  const repoPath = (owner: string, repo: string): string => {
    if (!isRepoPart(owner) || !isRepoPart(repo)) {
      throw new GithubApiError("invalid");
    }
    return `/repos/${owner}/${repo}`;
  };

  const assertSha = (sha: string): string => {
    if (!SHA_PATTERN.test(sha)) {
      throw new GithubApiError("invalid");
    }
    return sha;
  };

  return {
    async getDefaultBranch(owner, repo) {
      const { body } = await get(repoPath(owner, repo));
      const branch = isRecord(body) ? str(body.default_branch) : "";
      if (!branch) {
        throw new GithubApiError("invalid");
      }
      return branch;
    },

    async listBranches(owner, repo, etag) {
      const base = repoPath(owner, repo);
      const branches: BranchHead[] = [];
      let firstEtag: string | null = null;
      let multiPage = false;
      let truncated = false;

      for (let page = 1; page <= MAX_BRANCH_PAGES; page += 1) {
        // 只有第一頁能用 ETag 做條件請求；有後續頁面的 repo 在下面會放棄 ETag。
        const response = await get(`${base}/branches?per_page=${BRANCHES_PER_PAGE}&page=${page}`, page === 1 ? etag : null);
        if (response.status === 304) {
          return { kind: "not-modified" };
        }
        if (page === 1) {
          firstEtag = response.headers.get("etag");
        }
        for (const item of Array.isArray(response.body) ? response.body : []) {
          if (isRecord(item) && typeof item.name === "string" && isRecord(item.commit) && typeof item.commit.sha === "string") {
            branches.push({ name: item.name, sha: item.commit.sha });
          }
        }
        if (!nextLink(response.headers.get("link"))) {
          break;
        }
        multiPage = true;
        if (page === MAX_BRANCH_PAGES) {
          truncated = true;
        }
      }

      return { kind: "ok", branches, etag: multiPage ? null : firstEtag, truncated };
    },

    async compare(owner, repo, base, head) {
      const path = `${repoPath(owner, repo)}/compare/${assertSha(base)}...${assertSha(head)}?per_page=100`;
      const { body } = await get(path);
      if (!isRecord(body)) {
        throw new GithubApiError("invalid");
      }
      const commits = (Array.isArray(body.commits) ? body.commits : []).flatMap((item) => {
        const parsed = parseCommit(item);
        return parsed ? [parsed] : [];
      });
      return {
        // compare 由舊到新；只留最新的一批。
        commits: commits.slice(-MAX_STORED_COMMITS),
        files: parseFiles(body.files),
        totalCommits: typeof body.total_commits === "number" ? body.total_commits : commits.length
      };
    },

    async getCommit(owner, repo, sha) {
      const { body } = await get(`${repoPath(owner, repo)}/commits/${assertSha(sha)}`);
      const commit = parseCommit(body);
      if (!commit || !isRecord(body)) {
        throw new GithubApiError("invalid");
      }
      return { ...commit, files: parseFiles(body.files) };
    }
  };
};
