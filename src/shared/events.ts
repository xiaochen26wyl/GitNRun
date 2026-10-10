/** 推送事件的共用型別（資料庫、監視器、規則引擎、渲染層共用）。 */

export type EventSource = "poll" | "webhook";
export type EventType = "push" | "create" | "delete";

export type ChangedFileStatus = "added" | "modified" | "removed" | "renamed";

export interface ChangedFile {
  path: string;
  status: ChangedFileStatus;
  previousPath?: string;
}

export interface CommitSummary {
  sha: string;
  message: string;
  author: string;
  /** epoch ms */
  timestamp: number;
}

export interface PushEvent {
  id: number;
  projectId: number;
  eventType: EventType;
  /** 例：refs/heads/main */
  ref: string;
  branch: string;
  beforeSha: string | null;
  /** 刪除分支時為被刪除前的 head SHA，讓「刪除—重建—再刪除」不會互相覆蓋。 */
  afterSha: string;
  pusher: string | null;
  /** true 表示推送者是由 head commit 作者推定，不是 GitHub 回報的確切 pusher。 */
  pusherInferred: boolean;
  headMessage: string;
  commits: CommitSummary[];
  files: ChangedFile[];
  fileCount: number;
  branchViolation: boolean;
  source: EventSource;
  /** epoch ms */
  occurredAt: number;
  createdAt: number;
}

export type NewPushEvent = Omit<PushEvent, "id" | "createdAt">;

export interface EventQuery {
  projectId?: number;
  branch?: string;
  pusher?: string;
  /** epoch ms，含 */
  fromMs?: number;
  /** epoch ms，含 */
  toMs?: number;
  search?: string;
  branchViolationOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface EventPage {
  events: PushEvent[];
  hasMore: boolean;
}

export const EVENT_QUERY_DEFAULT_LIMIT = 50;
export const EVENT_QUERY_MAX_LIMIT = 200;
