import {
  DEFAULT_BRANCH_TEMPLATE,
  type BranchRuleScopeName,
  DEFAULT_EXEMPT_BRANCHES,
  DEFAULT_VERSION_SOURCE,
  VERSION_SOURCES,
  type VersionSource
} from "@shared/branch-template";
import type { Db } from "@main/db/database";

/** project_id = 0 代表全域預設範本。 */
export const GLOBAL_SCOPE = 0;

export interface StoredBranchRule {
  template: string;
  versionSource: VersionSource;
  exempt: string[];
  /** 這份規則從哪裡來：專案自己的覆寫、全域預設，或程式內建的預設。 */
  scope: BranchRuleScopeName;
}

export interface BranchRuleInput {
  template: string;
  versionSource: VersionSource;
  exempt: string[];
}

const parseExempt = (value: unknown): string[] => {
  try {
    const parsed: unknown = JSON.parse(String(value));
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? (parsed as string[]) : [];
  } catch {
    return [];
  }
};

const asVersionSource = (value: unknown): VersionSource =>
  VERSION_SOURCES.find((source) => source === value) ?? DEFAULT_VERSION_SOURCE;

const readRow = (db: Db, projectId: number): StoredBranchRule | null => {
  const row = db.prepare("SELECT template, version_source, exempt_json FROM branch_rules WHERE project_id = ?").get(projectId);
  if (!row) {
    return null;
  }
  return {
    template: String(row.template),
    versionSource: asVersionSource(row.version_source),
    exempt: parseExempt(row.exempt_json),
    scope: projectId === GLOBAL_SCOPE ? "global" : "project"
  };
};

export const BUILT_IN_BRANCH_RULE: StoredBranchRule = {
  template: DEFAULT_BRANCH_TEMPLATE,
  versionSource: DEFAULT_VERSION_SOURCE,
  exempt: [...DEFAULT_EXEMPT_BRANCHES],
  scope: "default"
};

/** 專案自己的覆寫 → 全域預設 → 內建預設。 */
export const getEffectiveBranchRule = (db: Db, projectId: number): StoredBranchRule =>
  (projectId === GLOBAL_SCOPE ? null : readRow(db, projectId)) ?? readRow(db, GLOBAL_SCOPE) ?? { ...BUILT_IN_BRANCH_RULE };

/** 只讀取指定範圍自己的那一份（不做 fallback），給編輯畫面判斷「有沒有覆寫」。 */
export const getOwnBranchRule = (db: Db, projectId: number): StoredBranchRule | null => readRow(db, projectId);

export const saveBranchRule = (db: Db, projectId: number, input: BranchRuleInput, now: number = Date.now()): void => {
  db.prepare(
    `INSERT INTO branch_rules (project_id, template, version_source, exempt_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       template = excluded.template, version_source = excluded.version_source,
       exempt_json = excluded.exempt_json, updated_at = excluded.updated_at`
  ).run(projectId, input.template, input.versionSource, JSON.stringify(input.exempt), now, now);
};

export const deleteBranchRule = (db: Db, projectId: number): void => {
  db.prepare("DELETE FROM branch_rules WHERE project_id = ?").run(projectId);
};
