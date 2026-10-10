import type { ChangedFile, CommitSummary } from "@shared/events";
import {
  GithubApiError,
  type BranchHead,
  type BranchListResult,
  type CompareResult,
  type GithubClient
} from "@main/github/client";

export const sha = (n: number): string => n.toString(16).padStart(40, "0");

export const commit = (n: number, message: string, author = "octocat", timestamp = 1_700_000_000_000 + n): CommitSummary => ({
  sha: sha(n),
  message,
  author,
  timestamp
});

export interface FakeRepo {
  defaultBranch: string;
  branches: BranchHead[];
  etag: string;
  truncated: boolean;
  /** key: `${base}...${head}` */
  compares: Map<string, CompareResult>;
  commits: Map<string, CommitSummary & { files: ChangedFile[] }>;
  /** 設定後，對應名稱的呼叫會丟出這個錯誤。 */
  failures: Partial<Record<"list" | "compare" | "getCommit" | "getDefaultBranch", GithubApiError>>;
}

export const createFakeRepo = (overrides: Partial<FakeRepo> = {}): FakeRepo => ({
  defaultBranch: "main",
  branches: [],
  etag: 'W/"etag-1"',
  truncated: false,
  compares: new Map(),
  commits: new Map(),
  failures: {},
  ...overrides
});

export interface FakeClient {
  client: GithubClient;
  calls: string[];
}

export const createFakeClient = (repo: FakeRepo): FakeClient => {
  const calls: string[] = [];
  const client: GithubClient = {
    async getDefaultBranch() {
      calls.push("getDefaultBranch");
      if (repo.failures.getDefaultBranch) {
        throw repo.failures.getDefaultBranch;
      }
      return repo.defaultBranch;
    },
    async listBranches(_owner, _repo, etag): Promise<BranchListResult> {
      calls.push(etag ? `list(etag)` : "list");
      if (repo.failures.list) {
        throw repo.failures.list;
      }
      if (etag && etag === repo.etag) {
        return { kind: "not-modified" };
      }
      return {
        kind: "ok",
        branches: repo.branches.map((branch) => ({ ...branch })),
        etag: repo.etag,
        truncated: repo.truncated
      };
    },
    async compare(_owner, _repo, base, head) {
      calls.push(`compare ${base.slice(-2)}...${head.slice(-2)}`);
      if (repo.failures.compare) {
        throw repo.failures.compare;
      }
      const result = repo.compares.get(`${base}...${head}`);
      if (!result) {
        throw new GithubApiError("not-found", 404);
      }
      return result;
    },
    async getCommit(_owner, _repo, requested) {
      calls.push(`getCommit ${requested.slice(-2)}`);
      if (repo.failures.getCommit) {
        throw repo.failures.getCommit;
      }
      const result = repo.commits.get(requested);
      if (!result) {
        throw new GithubApiError("not-found", 404);
      }
      return result;
    }
  };
  return { client, calls };
};
