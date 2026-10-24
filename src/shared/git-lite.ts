/** 輕量 Git/GitHub 讀取頁：只做本機 git 狀態與 GitHub issue 查詢，不接舊監視器。 */

import { normalizeFolderPath } from "@shared/launcher";
import { runGroupIdOf, type RunGroupId } from "@shared/run-groups";

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

/** issue 讀取失敗的種類：畫面靠它決定按鈕，不必比對中文訊息。 */
export type GitLiteIssueErrorKind = "no-token" | "token-rejected" | "not-found" | "network" | "http";

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
  /** GitHub 單頁回傳已達上限（濾掉 PR 之前計算），代表實際可能還有更多 open issues。 */
  issuesTruncated: boolean;
  statusError: string | null;
  issueError: string | null;
  issueErrorKind: GitLiteIssueErrorKind | null;
}

export interface GitLiteOverview {
  githubTokenConfigured: boolean;
  projects: GitLiteProject[];
}

/** issues 為 false 時只讀本機 git，完全不呼叫 GitHub；省略時視為 true。 */
export interface GitLiteOverviewOptions {
  issues: boolean;
}

/** 依變更檔案數由多到少排名；同數量比未追蹤檔，再依名稱；非 git repo 排最後。 */
export const rankByChangedFiles = (projects: readonly GitLiteProject[]): GitLiteProject[] =>
  [...projects].sort((a, b) => {
    if (a.isGitRepo !== b.isGitRepo) return a.isGitRepo ? -1 : 1;
    return b.changedFiles - a.changedFiles || b.untrackedFiles - a.untrackedFiles || a.label.localeCompare(b.label);
  });

/* 專案啟動頁的 issue 區塊：把 overview 整理成畫面要畫的狀態，所有判斷集中在這裡，renderer 只負責呈現。 */

/** issue 區塊預設顯示的筆數；其餘收在「再顯示 N 筆」後面。 */
export const ISSUE_PREVIEW_COUNT = 5;

/** 讀取 overview 的進度：載入中、失敗（附訊息）、或已取得。 */
export type IssueFeed =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; overview: GitLiteOverview };

/** 失敗時畫面上的處理：token 類去設定頁、連線類重試、找不到 repo 沒有可做的事。 */
export type IssueAction = "settings" | "retry" | null;

export type IssueSectionPlan =
  | { kind: "hidden" }
  | { kind: "loading" }
  | { kind: "no-github" }
  | { kind: "no-token"; message: string }
  | { kind: "error"; message: string; action: IssueAction }
  | { kind: "empty"; repo: GitLiteRepo; countLabel: string }
  | {
      kind: "list";
      repo: GitLiteRepo;
      countLabel: string;
      visible: GitLiteIssue[];
      /** 被收起來的筆數；0 代表不需要展開按鈕。 */
      hiddenCount: number;
      truncated: boolean;
    };

const ACTION_BY_ERROR_KIND: Record<GitLiteIssueErrorKind, IssueAction> = {
  "no-token": "settings",
  "token-rejected": "settings",
  "not-found": null,
  network: "retry",
  http: "retry"
};

const folderKey = (folder: string): string => normalizeFolderPath(folder);

/** 不讀取 GitHub issues 的分組（專案啟動頁的頁籤）：主程序不會替這些分組的專案發出請求，畫面也不顯示 issue 區塊與開關。 */
const ISSUE_SKIP_GROUP_IDS: ReadonlySet<RunGroupId> = new Set<RunGroupId>(["open-source"]);

export const isIssueSkippedGroup = (id: RunGroupId): boolean => ISSUE_SKIP_GROUP_IDS.has(id);

/** 專案跟著所屬分組走：分組表（run-groups）調整誰屬於哪組，這裡自動跟著變。 */
export const isIssueSkippedFolder = (folder: string): boolean => isIssueSkippedGroup(runGroupIdOf(folder));

/** 依資料夾路徑找 overview 裡對應的專案；比對前先去掉尾端斜線。 */
export const findGitLiteProject = (overview: GitLiteOverview, folder: string): GitLiteProject | null => {
  const key = folderKey(folder);
  return overview.projects.find((project) => folderKey(project.folder) === key) ?? null;
};

/** 計數膠囊文字：被截斷時只知道「至少」這麼多，所以加上 +。 */
export const issueCountLabel = (count: number, truncated: boolean): string => `${count}${truncated ? "+" : ""} open`;

/** expanded 為 false 時只回前 ISSUE_PREVIEW_COUNT 筆，順序沿用 GitHub 回傳。 */
export const planIssueSection = (feed: IssueFeed, folder: string, expanded: boolean): IssueSectionPlan => {
  if (isIssueSkippedFolder(folder)) return { kind: "hidden" };
  if (feed.status === "loading") return { kind: "loading" };
  if (feed.status === "failed") return { kind: "error", message: feed.message, action: "retry" };

  const project = findGitLiteProject(feed.overview, folder);
  if (project === null || !project.isGitRepo) return { kind: "hidden" };
  if (project.repo === null) return { kind: "no-github" };

  if (project.issueErrorKind !== null) {
    const message = project.issueError ?? "無法讀取 issues";
    if (project.issueErrorKind === "no-token") return { kind: "no-token", message };
    return { kind: "error", message, action: ACTION_BY_ERROR_KIND[project.issueErrorKind] };
  }

  const { repo, issues, issuesTruncated } = project;
  const countLabel = issueCountLabel(issues.length, issuesTruncated);
  if (issues.length === 0) return { kind: "empty", repo, countLabel };

  const hiddenCount = Math.max(0, issues.length - ISSUE_PREVIEW_COUNT);
  return {
    kind: "list",
    repo,
    countLabel,
    visible: expanded ? issues : issues.slice(0, ISSUE_PREVIEW_COUNT),
    hiddenCount,
    truncated: issuesTruncated
  };
};

export interface IssueGroupSummary {
  projectCount: number;
  /** 沒有任何專案成功讀到 issues（載入中、失敗、沒 token）時為 null，畫面就不顯示這顆膠囊。 */
  openIssues: { count: number; truncated: boolean } | null;
}

/** 一個分組的摘要：專案數，以及成功讀到 issues 的專案加總（任何一個被截斷，總數就是下限）。 */
export const summarizeIssueGroup = (feed: IssueFeed, folders: readonly string[]): IssueGroupSummary => {
  const summary: IssueGroupSummary = { projectCount: folders.length, openIssues: null };
  if (feed.status !== "ready") return summary;

  let count = 0;
  let truncated = false;
  let loaded = 0;
  for (const folder of folders) {
    if (isIssueSkippedFolder(folder)) continue;
    const project = findGitLiteProject(feed.overview, folder);
    if (project === null || project.repo === null || project.issueErrorKind !== null) continue;
    loaded += 1;
    count += project.issues.length;
    truncated = truncated || project.issuesTruncated;
  }
  return loaded === 0 ? summary : { ...summary, openIssues: { count, truncated } };
};

export const formatGroupIssueTotal = (total: { count: number; truncated: boolean }): string =>
  `${total.count}${total.truncated ? "+" : ""} 筆 open issues`;

/* 專案卡片標題下的變更檔案數：判斷集中在這裡，renderer 只負責呈現。 */

/** 變更檔案數達到這個數字就該推送了。 */
export const PUSH_REMINDER_THRESHOLD = 100;

export type ChangeBadgePlan =
  | { kind: "hidden" }
  | {
      kind: "badge";
      count: number;
      text: string;
      /** 達門檻才有，畫面用來換警示色並附上提示。 */
      reminder: string | null;
    };

/** 載入中、失敗、找不到專案、非 git repo、讀不到 git 狀態時都不顯示，避免誤報 0。 */
export const planChangeBadge = (feed: IssueFeed, folder: string): ChangeBadgePlan => {
  if (feed.status !== "ready") return { kind: "hidden" };
  const project = findGitLiteProject(feed.overview, folder);
  if (project === null || !project.isGitRepo || project.statusError !== null) return { kind: "hidden" };

  const { changedFiles } = project;
  return {
    kind: "badge",
    count: changedFiles,
    text: `變更檔案 ${changedFiles}／${PUSH_REMINDER_THRESHOLD}`,
    reminder: changedFiles >= PUSH_REMINDER_THRESHOLD ? `已達 ${PUSH_REMINDER_THRESHOLD}，該推送了` : null
  };
};

/** 「在專案下方顯示 GitHub issues」的偏好：只有明確存成 0 才關閉，沒存過或值不合法都當作開啟。 */
export const parseIssueDisplayPref = (stored: string | null | undefined): boolean => stored !== "0";

export const serializeIssueDisplayPref = (enabled: boolean): "0" | "1" => (enabled ? "1" : "0");
