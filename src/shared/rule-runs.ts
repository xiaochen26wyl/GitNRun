import type { ActionType } from "@shared/rules";

/** 規則執行結果的共用型別（引擎、IPC、渲染層共用）。 */

export type ActionStatus = "success" | "failed" | "timeout" | "declined" | "unsupported";

export interface ActionReport {
  index: number;
  type: ActionType;
  write: boolean;
  status: ActionStatus;
  message: string;
}

export type RuleRunStatus = "running" | "success" | "failed" | "timeout" | "declined" | "interrupted";

export interface RuleExecution {
  id: number;
  ruleId: number | null;
  ruleName: string;
  eventId: number;
  status: RuleRunStatus;
  startedAt: number;
  finishedAt: number | null;
  actions: ActionReport[];
}

export interface DryRunReport {
  matched: boolean;
  conditions: Array<{ type: string; matched: boolean }>;
  actions: Array<{ index: number; type: ActionType; write: boolean; requiresConfirmation: boolean; summary: string }>;
}

export interface RulePreviewReport {
  examined: number;
  matchedEventIds: number[];
}

export interface ConfirmRequest {
  ruleName: string;
  projectName: string;
  branch: string;
  pusher: string | null;
  headMessage: string;
  actionType: ActionType;
  /** 將要做的事（完整指令、工作目錄、目標網址等），不含任何金鑰值。 */
  summary: string;
}

export type ConfirmDecision = "allow" | "deny" | "timeout";

export interface RulesExportResult {
  saved: boolean;
  path?: string;
}

export interface RulesImportResult {
  /** 使用者在檔案選擇視窗按了取消。 */
  cancelled: boolean;
  imported?: number;
  renamed?: number;
}
