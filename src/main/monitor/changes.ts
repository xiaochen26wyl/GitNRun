import type { ChangedFile, CommitSummary, EventType, NewPushEvent } from "@shared/events";
import { matchesAnyGlob } from "@shared/glob";
import type { BranchHead } from "@main/github/client";

/** 分支變化偵測與事件建構（純函式，不碰網路與資料庫）。 */

export type BranchChangeKind = "created" | "updated" | "deleted";

export interface BranchChange {
  kind: BranchChangeKind;
  branch: string;
  /** created 時為 null。 */
  beforeSha: string | null;
  /** deleted 時為 null。 */
  afterSha: string | null;
}

export const filterBranches = (branches: readonly BranchHead[], filter: readonly string[]): BranchHead[] =>
  branches.filter((branch) => matchesAnyGlob(filter, branch.name));

export interface DetectOptions {
  /** 清單被截斷時不能因為「沒看到」就判定分支被刪除。 */
  allowDeletes: boolean;
}

/** 以名稱排序，讓同一輪裡事件的產生順序是確定的。 */
export const detectBranchChanges = (
  previous: ReadonlyMap<string, string>,
  current: readonly BranchHead[],
  options: DetectOptions
): BranchChange[] => {
  const changes: BranchChange[] = [];
  const seen = new Set<string>();

  for (const { name, sha } of current) {
    seen.add(name);
    const before = previous.get(name);
    if (before === undefined) {
      changes.push({ kind: "created", branch: name, beforeSha: null, afterSha: sha });
    } else if (before !== sha) {
      changes.push({ kind: "updated", branch: name, beforeSha: before, afterSha: sha });
    }
  }

  if (options.allowDeletes) {
    for (const [name, sha] of previous) {
      if (!seen.has(name)) {
        changes.push({ kind: "deleted", branch: name, beforeSha: sha, afterSha: null });
      }
    }
  }

  return changes.sort((a, b) => (a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0));
};

const MAX_HEAD_MESSAGE = 200;

export const firstLine = (message: string): string => (message.split("\n", 1)[0] ?? "").trim().slice(0, MAX_HEAD_MESSAGE);

const EVENT_TYPE: Record<BranchChangeKind, EventType> = {
  created: "create",
  updated: "push",
  deleted: "delete"
};

export interface BuildEventArgs {
  projectId: number;
  change: BranchChange;
  commits: CommitSummary[];
  files: ChangedFile[];
  /** 最新的一個 commit；用來推定推送者與取得訊息。 */
  headCommit: CommitSummary | null;
  /** 偵測到這次推送的時間。 */
  now: number;
}

/**
 * 輪詢模式的事件。GitHub 分支清單不告訴我們「誰推的」，所以推送者是以 head commit
 * 的作者推定（pusherInferred = true）；確切的 pusher 只有 Webhook 模式拿得到。
 * 發生時間用偵測時間而不是 commit 時間：重新定基（rebase）後推上來的舊 commit
 * 不應該排到歷史深處。
 */
export const buildPushEvent = (args: BuildEventArgs): NewPushEvent => {
  const { change, headCommit } = args;
  const deleted = change.kind === "deleted";
  const afterSha = deleted ? (change.beforeSha as string) : (change.afterSha as string);

  return {
    projectId: args.projectId,
    eventType: EVENT_TYPE[change.kind],
    ref: `refs/heads/${change.branch}`,
    branch: change.branch,
    beforeSha: change.beforeSha,
    afterSha,
    pusher: deleted ? null : (headCommit?.author ?? null),
    pusherInferred: true,
    headMessage: deleted || !headCommit ? "" : firstLine(headCommit.message),
    commits: args.commits,
    files: args.files,
    fileCount: args.files.length,
    branchViolation: false,
    source: "poll",
    occurredAt: args.now
  };
};
