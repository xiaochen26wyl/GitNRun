import type { PushEvent } from "@shared/events";
import type { Project } from "@shared/projects";
import type {
  ActionReport,
  ConfirmDecision,
  ConfirmRequest,
  DryRunReport,
  RulePreviewReport,
  RuleRunStatus
} from "@shared/rule-runs";
import { isWriteAction, type ActionType, type Rule, type RuleAction, type RuleInput } from "@shared/rules";
import type { Db } from "@main/db/database";
import { queryEvents } from "@main/db/events-repo";
import { getProject } from "@main/db/projects-repo";
import {
  countExecutionsSince,
  finishExecution,
  lastExecutionStart,
  startExecution
} from "@main/db/rule-executions-repo";
import { isSelfCaused, listEnabledRules } from "@main/db/rules-repo";
import type { LogEntry } from "@main/logger";
import { evaluateRule } from "@main/rules/conditions";

/**
 * 規則引擎。
 *
 * 一個事件進來：依優先順序（小的先）逐條評估規則；符合的規則依序執行動作。
 * 寫入型動作（commit／push／pull／merge、自訂 shell、外送 Webhook 等）預設先請使用者確認；
 * 唯讀動作（通知、摘要）直接執行。事件內容只當資料，從不拼進指令。
 */

export interface ActionContext {
  rule: Rule;
  event: PushEvent;
  project: Project;
  /**
   * 同一次規則執行中，前面的動作留下來的輸出（例如 AI 產生的摘要、commit 訊息）。
   * 後面的動作可以在通知文字用 {名稱}、在 shell 用 PW_<名稱> 環境變數取得。
   */
  variables?: Readonly<Record<string, string>>;
}

export interface ActionResult {
  status: "success" | "failed" | "timeout";
  message: string;
  /** 成功時可附上輸出，供同一次執行中後面的動作使用。 */
  output?: { name: string; value: string };
}

export interface ActionExecutor<A extends RuleAction = RuleAction> {
  /** 給確認視窗與乾跑顯示的人話描述；不得包含密鑰值。可以做唯讀的檢查。 */
  describe(action: A, context: ActionContext): string | Promise<string>;
  run(action: A, context: ActionContext): Promise<ActionResult>;
}

export type ActionExecutors = {
  [T in ActionType]?: ActionExecutor<Extract<RuleAction, { type: T }>>;
};

export type ConfirmFn = (request: ConfirmRequest) => Promise<ConfirmDecision>;

export interface RuleEngineDeps {
  db: Db;
  now: () => number;
  executors: ActionExecutors;
  confirm: ConfirmFn;
  log: (entry: LogEntry) => void;
  /** 每條規則每小時最多執行幾次，作為失控迴圈的最後防線。 */
  maxRunsPerHour?: number;
}

export interface RuleRunReport {
  ruleId: number;
  ruleName: string;
  status: RuleRunStatus;
  actions: ActionReport[];
}

export interface RuleEngine {
  /** 排進佇列、逐一在背景處理；不會阻塞呼叫端（輪詢流程）。 */
  enqueue(event: PushEvent, project: Project): void;
  /** 立即處理一個事件（佇列內部與測試使用）。 */
  runForEvent(event: PushEvent, project: Project): Promise<RuleRunReport[]>;
  /** 等待佇列清空（測試與關閉程式時使用）。 */
  idle(): Promise<void>;
  /** 乾跑：只評估條件並列出動作會怎麼做，不執行任何動作。 */
  dryRun(rule: RuleInput, event: PushEvent, project: Project): Promise<DryRunReport>;
  /** 用歷史事件看這條規則會命中哪些。 */
  previewMatches(rule: RuleInput, limit?: number): RulePreviewReport;
}

export const DEFAULT_MAX_RUNS_PER_HOUR = 30;
const HOUR_MS = 60 * 60 * 1000;
const PREVIEW_DEFAULT_LIMIT = 200;

const UNSUPPORTED: ActionReport["status"] = "unsupported";

const deriveStatus = (reports: readonly ActionReport[]): Exclude<RuleRunStatus, "running" | "interrupted"> => {
  if (reports.some((report) => report.status === "failed" || report.status === UNSUPPORTED)) return "failed";
  if (reports.some((report) => report.status === "timeout")) return "timeout";
  if (reports.some((report) => report.status === "declined")) return "declined";
  return "success";
};

export const createRuleEngine = (deps: RuleEngineDeps): RuleEngine => {
  const { db } = deps;
  const maxRunsPerHour = deps.maxRunsPerHour ?? DEFAULT_MAX_RUNS_PER_HOUR;
  let tail: Promise<void> = Promise.resolve();

  const executorFor = <A extends RuleAction>(action: A): ActionExecutor<A> | undefined =>
    deps.executors[action.type] as unknown as ActionExecutor<A> | undefined;

  const skipReason = (rule: Rule, event: PushEvent): string | null => {
    const shas = [event.afterSha, ...event.commits.map((commit) => commit.sha)];
    if (isSelfCaused(db, rule.id, shas)) {
      return "這是這條規則自己造成的推送";
    }
    if (rule.cooldownSec > 0) {
      const last = lastExecutionStart(db, rule.id, event.projectId, event.branch);
      if (last !== null && deps.now() - last < rule.cooldownSec * 1000) {
        return `冷卻中（${rule.cooldownSec} 秒內不重複執行）`;
      }
    }
    if (countExecutionsSince(db, rule.id, deps.now() - HOUR_MS) >= maxRunsPerHour) {
      return `已達每小時 ${maxRunsPerHour} 次的執行上限`;
    }
    return null;
  };

  const executeAction = async (
    rule: Rule,
    action: RuleAction,
    index: number,
    event: PushEvent,
    project: Project,
    variables: Record<string, string>
  ): Promise<ActionReport> => {
    const write = isWriteAction(action.type);
    const base = { index, type: action.type, write };
    const executor = executorFor(action);
    if (!executor) {
      return { ...base, status: UNSUPPORTED, message: "這個動作類型目前尚未支援" };
    }

    const context: ActionContext = { rule, event, project, variables };
    try {
      if (write && !rule.skipConfirm) {
        const decision = await deps.confirm({
          ruleName: rule.name,
          projectName: project.name,
          branch: event.branch,
          pusher: event.pusher,
          headMessage: event.headMessage,
          actionType: action.type,
          summary: await executor.describe(action, context)
        });
        if (decision === "timeout") {
          return { ...base, status: "timeout", message: "逾時未確認，已跳過" };
        }
        if (decision !== "allow") {
          return { ...base, status: "declined", message: "使用者拒絕執行" };
        }
      }
      const result = await executor.run(action, context);
      if (result.status === "success" && result.output) {
        variables[result.output.name] = result.output.value;
      }
      return { ...base, status: result.status, message: result.message };
    } catch {
      // 執行器的錯誤可能帶有指令輸出；這裡只記固定文字，細節由各執行器自己脫敏後回報。
      return { ...base, status: "failed", message: "動作執行時發生未預期的錯誤" };
    }
  };

  const runRule = async (rule: Rule, event: PushEvent, project: Project): Promise<RuleRunReport> => {
    const executionId = startExecution(db, { ruleId: rule.id, ruleName: rule.name, eventId: event.id, now: deps.now() });
    const reports: ActionReport[] = [];
    const variables: Record<string, string> = {};

    for (const [index, action] of rule.actions.entries()) {
      const report = await executeAction(rule, action, index, event, project, variables);
      reports.push(report);
      // 失敗、被拒絕、逾時都算「沒成功」：除非這個動作標了「失敗後繼續」，否則後面的動作不再執行。
      if (report.status !== "success" && action.continueOnFailure !== true) {
        break;
      }
    }

    const status = deriveStatus(reports);
    finishExecution(db, executionId, status, reports, deps.now());
    deps.log({
      category: "rule",
      level: status === "success" ? "info" : "warn",
      message: `規則「${rule.name}」對 ${project.name} 的 ${event.branch}：${status}`,
      detail: { eventId: event.id, actions: reports }
    });
    return { ruleId: rule.id, ruleName: rule.name, status, actions: reports };
  };

  const runForEvent = async (event: PushEvent, project: Project): Promise<RuleRunReport[]> => {
    const reports: RuleRunReport[] = [];
    for (const rule of listEnabledRules(db)) {
      if (!evaluateRule(rule, event, project).matched) {
        continue;
      }
      const reason = skipReason(rule, event);
      if (reason) {
        deps.log({ category: "rule", level: "info", message: `規則「${rule.name}」略過：${reason}（${project.name} ${event.branch}）` });
        continue;
      }
      reports.push(await runRule(rule, event, project));
    }
    return reports;
  };

  return {
    enqueue(event, project) {
      tail = tail
        .then(() => runForEvent(event, project))
        .then(
          () => undefined,
          () => {
            deps.log({ category: "system", level: "error", message: "規則引擎處理事件時發生未預期的錯誤" });
          }
        );
    },

    runForEvent,
    idle: () => tail,

    async dryRun(rule, event, project) {
      const match = evaluateRule(rule, event, project);
      const actions: DryRunReport["actions"] = [];
      for (const [index, action] of rule.actions.entries()) {
        const executor = executorFor(action);
        const write = isWriteAction(action.type);
        let summary = "（這個動作類型目前尚未支援）";
        if (executor) {
          try {
            // describe 只做唯讀檢查；乾跑絕不呼叫 run。
            summary = await executor.describe(action, { rule: { ...rule, id: 0, createdAt: 0, updatedAt: 0 }, event, project });
          } catch {
            summary = "（無法產生說明）";
          }
        }
        actions.push({ index, type: action.type, write, requiresConfirmation: write && !rule.skipConfirm, summary });
      }
      return { matched: match.matched, conditions: match.conditions, actions };
    },

    previewMatches(rule, limit = PREVIEW_DEFAULT_LIMIT) {
      const { events } = queryEvents(db, { limit });
      const matchedEventIds: number[] = [];
      for (const event of events) {
        const project = getProject(db, event.projectId);
        if (project && evaluateRule(rule, event, project).matched) {
          matchedEventIds.push(event.id);
        }
      }
      return { examined: events.length, matchedEventIds };
    }
  };
};
