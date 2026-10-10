import type { SQLInputValue } from "node:sqlite";
import {
  EVENT_QUERY_DEFAULT_LIMIT,
  EVENT_QUERY_MAX_LIMIT,
  type ChangedFile,
  type CommitSummary,
  type EventPage,
  type EventQuery,
  type EventSource,
  type EventType,
  type NewPushEvent,
  type PushEvent
} from "@shared/events";
import type { Db } from "@main/db/database";

type Row = Record<string, unknown>;

const parseJsonArray = <T>(value: unknown): T[] => {
  if (typeof value !== "string") {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
};

const rowToEvent = (row: Row): PushEvent => ({
  id: Number(row.id),
  projectId: Number(row.project_id),
  eventType: row.event_type as EventType,
  ref: String(row.ref),
  branch: String(row.branch),
  beforeSha: row.before_sha === null ? null : String(row.before_sha),
  afterSha: String(row.after_sha),
  pusher: row.pusher === null ? null : String(row.pusher),
  pusherInferred: Number(row.pusher_inferred) === 1,
  headMessage: String(row.head_message),
  commits: parseJsonArray<CommitSummary>(row.commits_json),
  files: parseJsonArray<ChangedFile>(row.files_json),
  fileCount: Number(row.file_count),
  branchViolation: Number(row.branch_violation) === 1,
  source: row.source as EventSource,
  occurredAt: Number(row.occurred_at),
  createdAt: Number(row.created_at)
});

export interface InsertResult {
  id: number;
  /** false 表示冪等鍵已存在（例如輪詢與 Webhook 看到同一次推送），沒有新增資料。 */
  inserted: boolean;
}

export const insertEvent = (db: Db, event: NewPushEvent, now: number = Date.now()): InsertResult => {
  const result = db
    .prepare(
      `INSERT INTO push_events (
         project_id, event_type, ref, branch, before_sha, after_sha, pusher, pusher_inferred,
         head_message, commits_json, files_json, file_count, branch_violation, source,
         occurred_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, ref, after_sha, event_type) DO NOTHING`
    )
    .run(
      event.projectId,
      event.eventType,
      event.ref,
      event.branch,
      event.beforeSha,
      event.afterSha,
      event.pusher,
      event.pusherInferred ? 1 : 0,
      event.headMessage,
      JSON.stringify(event.commits),
      JSON.stringify(event.files),
      event.fileCount,
      event.branchViolation ? 1 : 0,
      event.source,
      event.occurredAt,
      now
    );

  if (Number(result.changes) > 0) {
    return { id: Number(result.lastInsertRowid), inserted: true };
  }

  const existing = db
    .prepare("SELECT id FROM push_events WHERE project_id = ? AND ref = ? AND after_sha = ? AND event_type = ?")
    .get(event.projectId, event.ref, event.afterSha, event.eventType);
  return { id: Number(existing?.id), inserted: false };
};

export const getEvent = (db: Db, id: number): PushEvent | null => {
  const row = db.prepare("SELECT * FROM push_events WHERE id = ?").get(id);
  return row ? rowToEvent(row) : null;
};

/** 使用者輸入當作字面字串搜尋：跳脫 LIKE 的萬用字元。 */
const likePattern = (input: string): string => `%${input.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

/** 篩選＋搜尋＋分頁。多取一筆判斷 hasMore，不做昂貴的 COUNT。 */
export const queryEvents = (db: Db, query: EventQuery = {}): EventPage => {
  const where: string[] = [];
  const params: SQLInputValue[] = [];

  if (query.projectId !== undefined) {
    where.push("project_id = ?");
    params.push(query.projectId);
  }
  if (query.branch) {
    where.push("branch = ?");
    params.push(query.branch);
  }
  if (query.pusher) {
    where.push("pusher = ?");
    params.push(query.pusher);
  }
  if (query.fromMs !== undefined) {
    where.push("occurred_at >= ?");
    params.push(query.fromMs);
  }
  if (query.toMs !== undefined) {
    where.push("occurred_at <= ?");
    params.push(query.toMs);
  }
  if (query.branchViolationOnly) {
    where.push("branch_violation = 1");
  }
  if (query.search) {
    const pattern = likePattern(query.search);
    where.push(
      "(branch LIKE ? ESCAPE '\\' OR pusher LIKE ? ESCAPE '\\' OR head_message LIKE ? ESCAPE '\\' OR after_sha LIKE ? ESCAPE '\\')"
    );
    params.push(pattern, pattern, pattern, pattern);
  }

  const limit = Math.min(Math.max(query.limit ?? EVENT_QUERY_DEFAULT_LIMIT, 1), EVENT_QUERY_MAX_LIMIT);
  const offset = Math.max(query.offset ?? 0, 0);
  const sql = `SELECT * FROM push_events
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY occurred_at DESC, id DESC
    LIMIT ? OFFSET ?`;

  const rows = db.prepare(sql).all(...params, limit + 1, offset);
  return {
    events: rows.slice(0, limit).map(rowToEvent),
    hasMore: rows.length > limit
  };
};
