import { validateRuleInput, type Rule, type RuleInput } from "@shared/rules";
import type { Db } from "@main/db/database";

type Row = Record<string, unknown>;

const parseJson = (value: unknown): unknown => {
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
};

/**
 * 從資料庫讀出的規則一律重新驗證。資料庫檔可能被手動改過或來自舊版本，
 * 驗證不過的規則直接視為不存在，絕不拿去執行。
 */
export const rowToRule = (row: Row): Rule | null => {
  const validation = validateRuleInput({
    name: row.name,
    enabled: Number(row.enabled) === 1,
    priority: Number(row.priority),
    matchMode: row.match_mode,
    conditions: parseJson(row.conditions_json),
    actions: parseJson(row.actions_json),
    cooldownSec: Number(row.cooldown_sec),
    skipConfirm: Number(row.skip_confirm) === 1
  });
  if (!validation.ok) {
    return null;
  }
  return { ...validation.value, id: Number(row.id), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
};

export const listRules = (db: Db): Rule[] =>
  db
    .prepare("SELECT * FROM rules ORDER BY priority, id")
    .all()
    .flatMap((row) => {
      const rule = rowToRule(row);
      return rule ? [rule] : [];
    });

/** 引擎用：只取啟用中的規則，依優先順序（小的先）。 */
export const listEnabledRules = (db: Db): Rule[] => listRules(db).filter((rule) => rule.enabled);

export const getRule = (db: Db, id: number): Rule | null => {
  const row = db.prepare("SELECT * FROM rules WHERE id = ?").get(id);
  return row ? rowToRule(row) : null;
};

export const createRule = (db: Db, input: RuleInput, now: number = Date.now()): Rule => {
  const result = db
    .prepare(
      `INSERT INTO rules (name, enabled, priority, match_mode, conditions_json, actions_json,
         cooldown_sec, skip_confirm, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.name,
      input.enabled ? 1 : 0,
      input.priority,
      input.matchMode,
      JSON.stringify(input.conditions),
      JSON.stringify(input.actions),
      input.cooldownSec,
      input.skipConfirm ? 1 : 0,
      now,
      now
    );
  return getRule(db, Number(result.lastInsertRowid)) as Rule;
};

export const updateRule = (db: Db, id: number, input: RuleInput, now: number = Date.now()): Rule | null => {
  const result = db
    .prepare(
      `UPDATE rules SET name = ?, enabled = ?, priority = ?, match_mode = ?, conditions_json = ?, actions_json = ?,
         cooldown_sec = ?, skip_confirm = ?, updated_at = ? WHERE id = ?`
    )
    .run(
      input.name,
      input.enabled ? 1 : 0,
      input.priority,
      input.matchMode,
      JSON.stringify(input.conditions),
      JSON.stringify(input.actions),
      input.cooldownSec,
      input.skipConfirm ? 1 : 0,
      now,
      id
    );
  return Number(result.changes) > 0 ? getRule(db, id) : null;
};

export const deleteRule = (db: Db, id: number): boolean =>
  Number(db.prepare("DELETE FROM rules WHERE id = ?").run(id).changes) > 0;

export const setRuleEnabled = (db: Db, id: number, enabled: boolean, now: number = Date.now()): boolean =>
  Number(db.prepare("UPDATE rules SET enabled = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, now, id).changes) > 0;

export const PRIORITY_STEP = 10;

/** 依傳入的順序重新編號（10、20、30…），讓之後插入新規則時有空間。 */
export const reorderRules = (db: Db, orderedIds: readonly number[], now: number = Date.now()): void => {
  const update = db.prepare("UPDATE rules SET priority = ?, updated_at = ? WHERE id = ?");
  orderedIds.forEach((id, index) => {
    update.run((index + 1) * PRIORITY_STEP, now, id);
  });
};

// ---------------------------------------------------------------------------
// 防迴圈：規則自己造成的推送
// ---------------------------------------------------------------------------

export const recordSelfSha = (db: Db, ruleId: number, sha: string, now: number = Date.now()): void => {
  db.prepare("INSERT OR IGNORE INTO rule_self_events (rule_id, sha, created_at) VALUES (?, ?, ?)").run(ruleId, sha, now);
};

/** 這條規則是否曾自己造成過這些 SHA 中的任何一個。 */
export const isSelfCaused = (db: Db, ruleId: number, shas: readonly string[]): boolean => {
  const statement = db.prepare("SELECT 1 AS hit FROM rule_self_events WHERE rule_id = ? AND sha = ? LIMIT 1");
  return shas.some((sha) => statement.get(ruleId, sha) !== undefined);
};
