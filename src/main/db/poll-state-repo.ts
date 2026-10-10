import type { Db } from "@main/db/database";

export interface PollMeta {
  etag: string | null;
  baselineDone: boolean;
  lastPolledAt: number | null;
  lastError: string | null;
}

export const getPollMeta = (db: Db, projectId: number): PollMeta => {
  const row = db.prepare("SELECT * FROM poll_meta WHERE project_id = ?").get(projectId);
  if (!row) {
    return { etag: null, baselineDone: false, lastPolledAt: null, lastError: null };
  }
  return {
    etag: row.etag === null ? null : String(row.etag),
    baselineDone: Number(row.baseline_done) === 1,
    lastPolledAt: row.last_polled_at === null ? null : Number(row.last_polled_at),
    lastError: row.last_error === null ? null : String(row.last_error)
  };
};

/** 只更新有帶的欄位；沒有這筆就先建立。 */
export const savePollMeta = (db: Db, projectId: number, patch: Partial<PollMeta>): void => {
  db.prepare("INSERT OR IGNORE INTO poll_meta (project_id) VALUES (?)").run(projectId);
  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  if (patch.etag !== undefined) {
    sets.push("etag = ?");
    params.push(patch.etag);
  }
  if (patch.baselineDone !== undefined) {
    sets.push("baseline_done = ?");
    params.push(patch.baselineDone ? 1 : 0);
  }
  if (patch.lastPolledAt !== undefined) {
    sets.push("last_polled_at = ?");
    params.push(patch.lastPolledAt);
  }
  if (patch.lastError !== undefined) {
    sets.push("last_error = ?");
    params.push(patch.lastError);
  }
  if (sets.length === 0) {
    return;
  }
  db.prepare(`UPDATE poll_meta SET ${sets.join(", ")} WHERE project_id = ?`).run(...params, projectId);
};

export const getHeads = (db: Db, projectId: number): Map<string, string> =>
  new Map(
    db
      .prepare("SELECT branch, head_sha FROM poll_state WHERE project_id = ?")
      .all(projectId)
      .map((row) => [String(row.branch), String(row.head_sha)])
  );

export const setHead = (db: Db, projectId: number, branch: string, sha: string, now: number): void => {
  db.prepare(
    `INSERT INTO poll_state (project_id, branch, head_sha, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id, branch) DO UPDATE SET head_sha = excluded.head_sha, updated_at = excluded.updated_at`
  ).run(projectId, branch, sha, now);
};

export const deleteHead = (db: Db, projectId: number, branch: string): void => {
  db.prepare("DELETE FROM poll_state WHERE project_id = ? AND branch = ?").run(projectId, branch);
};
