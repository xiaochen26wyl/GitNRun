import type { NormalizedProjectInput, Project, ProjectMode } from "@shared/projects";
import type { Db } from "@main/db/database";

type Row = Record<string, unknown>;

export class DuplicateProjectError extends Error {
  constructor() {
    super("this repository is already being monitored");
    this.name = "DuplicateProjectError";
  }
}

const parseFilter = (value: unknown): string[] => {
  try {
    const parsed: unknown = JSON.parse(String(value));
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? (parsed as string[]) : ["*"];
  } catch {
    return ["*"];
  }
};

const rowToProject = (row: Row): Project => ({
  id: Number(row.id),
  name: String(row.name),
  owner: String(row.owner),
  repo: String(row.repo),
  localPath: row.local_path === null ? null : String(row.local_path),
  defaultBranch: row.default_branch === null ? null : String(row.default_branch),
  branchFilter: parseFilter(row.branch_filter_json),
  pollIntervalSec: Number(row.poll_interval_sec),
  mode: row.mode as ProjectMode,
  aiEnabled: Number(row.ai_enabled) === 1,
  enabled: Number(row.enabled) === 1,
  createdAt: Number(row.created_at)
});

export const listProjects = (db: Db): Project[] =>
  db.prepare("SELECT * FROM projects ORDER BY owner, repo").all().map(rowToProject);

export const getProject = (db: Db, id: number): Project | null => {
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
  return row ? rowToProject(row) : null;
};

export const addProject = (db: Db, input: NormalizedProjectInput, now: number = Date.now()): Project => {
  try {
    const result = db
      .prepare(
        `INSERT INTO projects (name, owner, repo, local_path, branch_filter_json, poll_interval_sec, mode, enabled, ai_enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.name,
        input.owner,
        input.repo,
        input.localPath,
        JSON.stringify(input.branchFilter),
        input.pollIntervalSec,
        input.mode,
        input.enabled ? 1 : 0,
        input.aiEnabled ? 1 : 0,
        now
      );
    return getProject(db, Number(result.lastInsertRowid)) as Project;
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed: projects\.owner, projects\.repo/.test(error.message)) {
      throw new DuplicateProjectError();
    }
    throw error;
  }
};

/**
 * owner／repo 不可變更（要換 repo 就刪掉重加）。分支篩選改變時，輪詢基準要重建，
 * 否則新符合篩選的分支會被誤判成「剛建立」而灌進一批假事件。
 */
export const updateProject = (db: Db, id: number, input: NormalizedProjectInput): Project | null => {
  const current = getProject(db, id);
  if (!current) {
    return null;
  }
  db.prepare(
    `UPDATE projects SET name = ?, local_path = ?, branch_filter_json = ?, poll_interval_sec = ?, mode = ?, enabled = ?, ai_enabled = ?
     WHERE id = ?`
  ).run(
    input.name,
    input.localPath,
    JSON.stringify(input.branchFilter),
    input.pollIntervalSec,
    input.mode,
    input.enabled ? 1 : 0,
    input.aiEnabled ? 1 : 0,
    id
  );

  if (JSON.stringify(current.branchFilter) !== JSON.stringify(input.branchFilter)) {
    db.prepare("DELETE FROM poll_state WHERE project_id = ?").run(id);
    db.prepare("DELETE FROM poll_meta WHERE project_id = ?").run(id);
  }
  return getProject(db, id);
};

export const setDefaultBranch = (db: Db, id: number, branch: string): void => {
  db.prepare("UPDATE projects SET default_branch = ? WHERE id = ?").run(branch, id);
};

export const removeProject = (db: Db, id: number): boolean =>
  Number(db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes) > 0;
