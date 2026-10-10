import type { ChangedFile, CommitSummary } from "@shared/events";
import type { Project } from "@shared/projects";
import type { Db } from "@main/db/database";
import { deleteHead, getHeads, getPollMeta, savePollMeta, setHead } from "@main/db/poll-state-repo";
import { setDefaultBranch } from "@main/db/projects-repo";
import { GithubApiError, type BranchHead, type GithubClient } from "@main/github/client";
import {
  buildPushEvent,
  detectBranchChanges,
  filterBranches,
  type BranchChange
} from "@main/monitor/changes";
import type { IngestFn } from "@main/monitor/ingest";

/** 單次輪詢最多處理幾個變動的分支，其餘留到下一輪，避免一次爆量耗盡 rate limit。 */
export const MAX_CHANGES_PER_POLL = 20;

export interface PollerDeps {
  db: Db;
  client: GithubClient;
  ingest: IngestFn;
  now: () => number;
}

export interface PollOutcome {
  projectId: number;
  /** 條件式請求回 304，什麼都沒變。 */
  notModified: boolean;
  /** 這次是第一次輪詢，只建立基準快照、沒有產生事件。 */
  baselined: boolean;
  changes: number;
  eventsInserted: number;
  /** 還有分支沒處理完（超過單次上限或中途失敗前已處理的部分）。 */
  incomplete: boolean;
}

interface Details {
  commits: CommitSummary[];
  files: ChangedFile[];
  headCommit: CommitSummary | null;
}

const isBranchAccessError = (error: unknown): boolean =>
  error instanceof GithubApiError && (error.kind === "not-found" || error.kind === "invalid");

const fetchDetails = async (
  client: GithubClient,
  project: Project,
  change: BranchChange,
  defaultHeadSha: string | null
): Promise<Details> => {
  if (change.kind === "deleted") {
    return { commits: [], files: [], headCommit: null };
  }
  const head = change.afterSha as string;

  const single = async (includeFiles: boolean): Promise<Details> => {
    const commit = await client.getCommit(project.owner, project.repo, head);
    const { files, ...summary } = commit;
    return { commits: includeFiles ? [summary] : [], files: includeFiles ? files : [], headCommit: summary };
  };

  // 比較基準：更新用舊 head；新分支用預設分支的 head。
  const base = change.kind === "updated" ? change.beforeSha : defaultHeadSha;
  if (base && base !== head) {
    try {
      const compared = await client.compare(project.owner, project.repo, base, head);
      if (compared.commits.length > 0) {
        return {
          commits: compared.commits,
          files: compared.files,
          headCommit: compared.commits[compared.commits.length - 1] ?? null
        };
      }
    } catch (error) {
      // 舊 SHA 因為 force push 已不存在等情況：退回只看 head commit。
      if (!isBranchAccessError(error)) {
        throw error;
      }
    }
  }

  // 新分支沒有任何比預設分支多的 commit：只取 head 的訊息，不把預設分支的檔案算進這個分支。
  // 例外：預設分支本身是新建的（空 repo 的第一次推送），它的檔案就是這次推送的內容。
  const ownsHeadCommit = change.kind === "updated" || base === null || change.branch === project.defaultBranch;
  return single(ownsHeadCommit);
};

/**
 * 輪詢一個專案。
 *
 * - 第一次只建立基準快照，不補灌歷史事件。
 * - 之後以 ETag 條件式請求讀分支清單；304 不消耗 rate limit。
 * - 每個變動的分支各自處理，成功後才前進該分支的 head；失敗的分支下一輪會重試。
 * - 只有「所有變動都處理完」才保存 ETag，否則下一輪必須重新取得清單。
 */
export const pollProject = async (deps: PollerDeps, project: Project): Promise<PollOutcome> => {
  const { db, client } = deps;
  const meta = getPollMeta(db, project.id);
  const outcome: PollOutcome = {
    projectId: project.id,
    notModified: false,
    baselined: false,
    changes: 0,
    eventsInserted: 0,
    incomplete: false
  };

  const listing = await client.listBranches(project.owner, project.repo, meta.baselineDone ? meta.etag : null);
  const polledAt = deps.now();

  if (listing.kind === "not-modified") {
    savePollMeta(db, project.id, { lastPolledAt: polledAt, lastError: null });
    return { ...outcome, notModified: true };
  }

  const current: BranchHead[] = filterBranches(listing.branches, project.branchFilter);

  if (!meta.baselineDone) {
    if (!project.defaultBranch) {
      setDefaultBranch(db, project.id, await client.getDefaultBranch(project.owner, project.repo));
    }
    for (const { name, sha } of current) {
      setHead(db, project.id, name, sha, polledAt);
    }
    savePollMeta(db, project.id, {
      baselineDone: true,
      etag: listing.etag,
      lastPolledAt: polledAt,
      lastError: null
    });
    return { ...outcome, baselined: true };
  }

  const defaultBranch = project.defaultBranch;
  const defaultHeadSha = defaultBranch
    ? (listing.branches.find((branch) => branch.name === defaultBranch)?.sha ?? null)
    : null;

  const changes = detectBranchChanges(getHeads(db, project.id), current, { allowDeletes: !listing.truncated });
  outcome.changes = changes.length;
  const batch = changes.slice(0, MAX_CHANGES_PER_POLL);
  outcome.incomplete = changes.length > batch.length;

  for (const change of batch) {
    const details = await fetchDetails(client, project, change, defaultHeadSha);
    const event = buildPushEvent({
      projectId: project.id,
      change,
      commits: details.commits,
      files: details.files,
      headCommit: details.headCommit,
      now: deps.now()
    });
    const result = await deps.ingest(project, event);
    if (result.inserted) {
      outcome.eventsInserted += 1;
    }
    if (change.kind === "deleted") {
      deleteHead(db, project.id, change.branch);
    } else {
      setHead(db, project.id, change.branch, change.afterSha as string, deps.now());
    }
  }

  savePollMeta(db, project.id, {
    // 還有沒處理完的分支就不存 ETag，下一輪才不會被 304 擋掉。
    ...(outcome.incomplete ? {} : { etag: listing.etag }),
    lastPolledAt: polledAt,
    lastError: null
  });
  return outcome;
};
