import { basename } from "node:path";
import type { GitLiteIssue, GitLiteOverview, GitLiteProject, GitLiteRepo } from "@shared/git-lite";
import type { Db } from "@main/db/database";
import { listProjects } from "@main/db/projects-repo";
import type { GitRunner } from "@main/git/run-git";
import { listRunFolders } from "@main/run/store";
import { SecretMissingError, SecretUnreadableError, type Vault } from "@main/vault/vault";

export interface GitLiteHandlersDeps {
  db: Db;
  runGit: GitRunner;
  vault: Pick<Vault, "getStatus" | "useSecret">;
  fetchFn: typeof fetch;
}

export interface GitLiteHandlers {
  overview(): Promise<GitLiteOverview>;
}

interface Target {
  id: string;
  label: string;
  folder: string;
  source: "project" | "folder";
}

const MAX_ISSUES = 20;
const GITHUB_REMOTE_PATTERNS = [
  /^https:\/\/github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?$/i,
  /^git@github\.com:([^/]+)\/([^/.]+?)(?:\.git)?$/i,
  /^ssh:\/\/git@github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?$/i
];

const parseGithubRemote = (remote: string): GitLiteRepo | null => {
  const trimmed = remote.trim();
  for (const pattern of GITHUB_REMOTE_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (match?.[1] && match[2]) {
      return {
        owner: match[1],
        repo: match[2],
        url: `https://github.com/${match[1]}/${match[2]}`
      };
    }
  }
  return null;
};

const safeNumber = (value: string): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
};

const parseStatus = (stdout: string): Pick<GitLiteProject, "changedFiles" | "stagedFiles" | "unstagedFiles" | "untrackedFiles"> => {
  let changedFiles = 0;
  let stagedFiles = 0;
  let unstagedFiles = 0;
  let untrackedFiles = 0;
  for (const line of stdout.split("\n")) {
    if (line.length < 2) continue;
    changedFiles += 1;
    if (line.startsWith("??")) {
      untrackedFiles += 1;
      continue;
    }
    if (line[0] !== " ") stagedFiles += 1;
    if (line[1] !== " ") unstagedFiles += 1;
  }
  return { changedFiles, stagedFiles, unstagedFiles, untrackedFiles };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string => (typeof value === "string" ? value : "");

const parseIssues = (raw: unknown): GitLiteIssue[] =>
  (Array.isArray(raw) ? raw : [])
    .filter((item) => isRecord(item) && !isRecord(item.pull_request))
    .slice(0, MAX_ISSUES)
    .flatMap((item) => {
      if (!isRecord(item) || typeof item.id !== "number" || typeof item.number !== "number") return [];
      const user = isRecord(item.user) ? item.user : {};
      const updatedAt = Date.parse(str(item.updated_at));
      return [
        {
          id: item.id,
          number: item.number,
          title: str(item.title),
          url: str(item.html_url),
          author: str(user.login) || "unknown",
          updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0
        }
      ];
    });

export const createGitLiteHandlers = (deps: GitLiteHandlersDeps): GitLiteHandlers => {
  const targets = (): Target[] => {
    const seen = new Set<string>();
    const result: Target[] = [];
    for (const project of listProjects(deps.db)) {
      if (!project.localPath) continue;
      if (seen.has(project.localPath)) continue;
      seen.add(project.localPath);
      result.push({ id: `p:${project.id}`, label: project.name, folder: project.localPath, source: "project" });
    }
    for (const folder of listRunFolders(deps.db)) {
      if (seen.has(folder.path)) continue;
      seen.add(folder.path);
      result.push({ id: `f:${folder.id}`, label: basename(folder.path) || folder.path, folder: folder.path, source: "folder" });
    }
    return result;
  };

  const readProject = async (target: Target): Promise<Omit<GitLiteProject, "issues" | "issueError">> => {
    const base = {
      id: target.id,
      label: target.label,
      folder: target.folder,
      source: target.source,
      isGitRepo: false,
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      changedFiles: 0,
      stagedFiles: 0,
      unstagedFiles: 0,
      untrackedFiles: 0,
      repo: null,
      statusError: null
    } satisfies Omit<GitLiteProject, "issues" | "issueError">;

    const inside = await deps.runGit(target.folder, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.code !== 0 || inside.stdout.trim() !== "true") {
      return { ...base, statusError: "不是 git repo" };
    }

    const branch = await deps.runGit(target.folder, ["branch", "--show-current"]);
    const upstream = await deps.runGit(target.folder, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    const counts =
      upstream.code === 0
        ? await deps.runGit(target.folder, ["rev-list", "--left-right", "--count", "HEAD...@{u}"])
        : null;
    const status = await deps.runGit(target.folder, ["status", "--porcelain=v1"]);
    const remote = await deps.runGit(target.folder, ["remote", "get-url", "origin"]);

    const [aheadText, behindText] = counts?.code === 0 ? counts.stdout.trim().split(/\s+/, 2) : [];
    return {
      ...base,
      isGitRepo: true,
      branch: branch.code === 0 ? branch.stdout.trim() || null : null,
      upstream: upstream.code === 0 ? upstream.stdout.trim() || null : null,
      ahead: safeNumber(aheadText ?? "0"),
      behind: safeNumber(behindText ?? "0"),
      ...parseStatus(status.code === 0 ? status.stdout : ""),
      repo: remote.code === 0 ? parseGithubRemote(remote.stdout) : null
    };
  };

  const readIssues = async (repo: GitLiteRepo | null): Promise<{ issues: GitLiteIssue[]; issueError: string | null }> => {
    if (!repo) {
      return { issues: [], issueError: null };
    }
    try {
      return await deps.vault.useSecret("github.pat", async (token) => {
        const response = await deps.fetchFn(`https://api.github.com/repos/${repo.owner}/${repo.repo}/issues?state=open&per_page=${MAX_ISSUES}`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "gitnrun"
          }
        });
        if (response.status === 401 || response.status === 403) {
          return { issues: [], issueError: "GitHub token 無法讀取 issues" };
        }
        if (response.status === 404) {
          return { issues: [], issueError: "找不到 GitHub repo 或沒有權限" };
        }
        if (response.status !== 200) {
          return { issues: [], issueError: `GitHub 回應 HTTP ${response.status}` };
        }
        return { issues: parseIssues(await response.json()), issueError: null };
      });
    } catch (error) {
      if (error instanceof SecretMissingError) return { issues: [], issueError: "尚未設定 GitHub token" };
      if (error instanceof SecretUnreadableError) return { issues: [], issueError: "GitHub token 無法解密，請重新輸入" };
      return { issues: [], issueError: "無法連線到 GitHub" };
    }
  };

  return {
    async overview() {
      const githubTokenConfigured = deps.vault.getStatus("github.pat").configured;
      const projects = await Promise.all(
        targets().map(async (target) => {
          const project = await readProject(target);
          const issueState = await readIssues(project.repo);
          return { ...project, ...issueState };
        })
      );
      return { githubTokenConfigured, projects };
    }
  };
};
