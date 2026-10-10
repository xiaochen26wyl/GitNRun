import type { ChangedFile, CommitSummary, NewPushEvent } from "@shared/events";
import { firstLine } from "@main/monitor/changes";

/**
 * GitHub `push` 事件的 payload → 與輪詢相同格式的事件。
 * Webhook 能拿到確切的推送者（sender.login），所以 pusherInferred 為 false。
 */

const ZERO_SHA = /^0{40,64}$/;
const SHA = /^[0-9a-f]{40,64}$/i;
const REF_PREFIX = "refs/heads/";
const MAX_COMMITS = 50;
const MAX_FILES = 300;
const MAX_COMMIT_MESSAGE = 1000;

export type ParsedPush =
  | { ok: true; fullName: string; branch: string; event: Omit<NewPushEvent, "projectId" | "branchViolation" | "occurredAt"> }
  | { ok: false; ignore: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/**
 * 依 commit 順序累積檔案狀態：新增後又刪除 = 淨效果為零（不列出）；刪除後又新增 = 修改。
 * payload 最多只帶 20 個 commit，推很多 commit 時檔案清單會是不完整的下限。
 */
export const aggregateFiles = (commits: ReadonlyArray<{ added: string[]; modified: string[]; removed: string[] }>): ChangedFile[] => {
  const state = new Map<string, ChangedFile["status"]>();
  for (const commit of commits) {
    for (const path of commit.added) {
      state.set(path, state.get(path) === "removed" ? "modified" : "added");
    }
    for (const path of commit.modified) {
      if (!state.has(path)) state.set(path, "modified");
    }
    for (const path of commit.removed) {
      if (state.get(path) === "added") state.delete(path);
      else state.set(path, "removed");
    }
  }
  return [...state.entries()].slice(0, MAX_FILES).map(([path, status]) => ({ path, status }));
};

export const parsePushPayload = (payload: unknown): ParsedPush => {
  if (!isRecord(payload)) return { ok: false, ignore: "payload is not an object" };

  const repository = isRecord(payload.repository) ? payload.repository : {};
  const fullName = str(repository.full_name);
  const ref = str(payload.ref);
  const after = str(payload.after);
  const before = str(payload.before);

  if (!fullName.includes("/")) return { ok: false, ignore: "missing repository" };
  if (!ref.startsWith(REF_PREFIX)) return { ok: false, ignore: "not a branch push" };
  const branch = ref.slice(REF_PREFIX.length);
  if (branch.length === 0 || !SHA.test(after) || !SHA.test(before)) return { ok: false, ignore: "malformed refs" };

  const deleted = payload.deleted === true || ZERO_SHA.test(after);
  const created = payload.created === true || ZERO_SHA.test(before);
  const eventType = deleted ? "delete" : created ? "create" : "push";

  const rawCommits = Array.isArray(payload.commits) ? payload.commits.filter(isRecord) : [];
  const commits: CommitSummary[] = rawCommits.slice(-MAX_COMMITS).flatMap((commit) => {
    const sha = str(commit.id);
    if (!SHA.test(sha)) return [];
    const author = isRecord(commit.author) ? commit.author : {};
    const time = Date.parse(str(commit.timestamp));
    return [
      {
        sha,
        message: str(commit.message).slice(0, MAX_COMMIT_MESSAGE),
        author: str(author.username) || str(author.name) || "unknown",
        timestamp: Number.isFinite(time) ? time : 0
      }
    ];
  });
  const files = deleted
    ? []
    : aggregateFiles(rawCommits.map((commit) => ({ added: strings(commit.added), modified: strings(commit.modified), removed: strings(commit.removed) })));

  const sender = isRecord(payload.sender) ? payload.sender : {};
  const pusherInfo = isRecord(payload.pusher) ? payload.pusher : {};
  const head = isRecord(payload.head_commit) ? payload.head_commit : null;

  return {
    ok: true,
    fullName,
    branch,
    event: {
      eventType,
      ref,
      branch,
      beforeSha: created ? null : before,
      // 刪除分支時 after 是全 0；改記被刪除前的 head，與輪詢的規則一致，也讓兩個來源的冪等鍵對得起來。
      afterSha: deleted ? before : after,
      pusher: str(sender.login) || str(pusherInfo.name) || null,
      pusherInferred: false,
      headMessage: deleted || !head ? "" : firstLine(str(head.message)),
      commits,
      files,
      fileCount: files.length,
      source: "webhook"
    }
  };
};
