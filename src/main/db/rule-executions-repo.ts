import type { ActionReport, RuleExecution, RuleRunStatus } from "@shared/rule-runs";
import type { Db } from "@main/db/database";

export const startExecution = (
  db: Db,
  args: { ruleId: number; ruleName: string; eventId: number; now: number }
): number => {
  const result = db
    .prepare(
      "INSERT INTO rule_executions (rule_id, rule_name, event_id, status, dry_run, started_at) VALUES (?, ?, ?, 'running', 0, ?)"
    )
    .run(args.ruleId, args.ruleName, args.eventId, args.now);
  return Number(result.lastInsertRowid);
};

export const finishExecution = (
  db: Db,
  id: number,
  status: Exclude<RuleRunStatus, "running">,
  actions: readonly ActionReport[],
  now: number
): void => {
  db.prepare("UPDATE rule_executions SET status = ?, finished_at = ?, detail_json = ? WHERE id = ?").run(
    status,
    now,
    JSON.stringify({ actions }),
    id
  );
};

/** 啟動時把上次沒有正常結束（程式被關掉、當掉）的執行標成 interrupted。 */
export const markInterruptedExecutions = (db: Db, now: number): number =>
  Number(
    db
      .prepare("UPDATE rule_executions SET status = 'interrupted', finished_at = ? WHERE status = 'running'")
      .run(now).changes
  );

/** 同一規則在同一專案同一分支上，最近一次真正執行（非跳過）的開始時間。 */
export const lastExecutionStart = (db: Db, ruleId: number, projectId: number, branch: string): number | null => {
  const row = db
    .prepare(
      `SELECT MAX(x.started_at) AS at FROM rule_executions x
       JOIN push_events e ON e.id = x.event_id
       WHERE x.rule_id = ? AND x.dry_run = 0 AND e.project_id = ? AND e.branch = ?`
    )
    .get(ruleId, projectId, branch);
  return row?.at === null || row?.at === undefined ? null : Number(row.at);
};

export const countExecutionsSince = (db: Db, ruleId: number, since: number): number =>
  Number(
    db.prepare("SELECT COUNT(*) AS n FROM rule_executions WHERE rule_id = ? AND dry_run = 0 AND started_at >= ?").get(ruleId, since)?.n
  );

export const listExecutions = (db: Db, options: { ruleId?: number; limit?: number } = {}): RuleExecution[] => {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const rows =
    options.ruleId === undefined
      ? db.prepare("SELECT * FROM rule_executions ORDER BY started_at DESC, id DESC LIMIT ?").all(limit)
      : db
          .prepare("SELECT * FROM rule_executions WHERE rule_id = ? ORDER BY started_at DESC, id DESC LIMIT ?")
          .all(options.ruleId, limit);

  return rows.map((row) => {
    let actions: ActionReport[] = [];
    try {
      const detail = JSON.parse(String(row.detail_json ?? "null")) as { actions?: ActionReport[] } | null;
      actions = Array.isArray(detail?.actions) ? detail.actions : [];
    } catch {
      // 細節壞掉不影響列表。
    }
    return {
      id: Number(row.id),
      ruleId: row.rule_id === null ? null : Number(row.rule_id),
      ruleName: String(row.rule_name),
      eventId: Number(row.event_id),
      status: String(row.status) as RuleRunStatus,
      startedAt: Number(row.started_at),
      finishedAt: row.finished_at === null ? null : Number(row.finished_at),
      actions
    };
  });
};
