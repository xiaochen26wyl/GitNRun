/** 輕量 Git/GitHub 讀取頁：只做本機 git 狀態與 GitHub issue 查詢，不接舊監視器。 */

export interface GitLiteIssue {
  id: number;
  number: number;
  title: string;
  url: string;
  author: string;
  updatedAt: number;
}

export interface GitLiteRepo {
  owner: string;
  repo: string;
  url: string;
}

export interface GitLiteProject {
  id: string;
  label: string;
  folder: string;
  source: "project" | "folder";
  isGitRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changedFiles: number;
  stagedFiles: number;
  unstagedFiles: number;
  untrackedFiles: number;
  repo: GitLiteRepo | null;
  issues: GitLiteIssue[];
  statusError: string | null;
  issueError: string | null;
}

export interface GitLiteOverview {
  githubTokenConfigured: boolean;
  projects: GitLiteProject[];
}
