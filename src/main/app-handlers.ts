import { validateBranchRuleInput, type BranchRuleView } from "@shared/branch-template";
import type { EventPage, EventQuery, PushEvent } from "@shared/events";
import type { LogPage, LogQuery } from "@shared/logs";
import type { MonitorStatus } from "@shared/monitor";
import { validateProjectInput, type NormalizedProjectInput, type Project } from "@shared/projects";
import type { StartWorkInput, StartWorkPreview, StartWorkResult } from "@shared/start-work";
import {
  GLOBAL_SCOPE,
  deleteBranchRule,
  getEffectiveBranchRule,
  getOwnBranchRule,
  saveBranchRule
} from "@main/db/branch-rules-repo";
import type { Db } from "@main/db/database";
import { getEvent, queryEvents } from "@main/db/events-repo";
import { queryLogs } from "@main/db/logs-repo";
import {
  DuplicateProjectError,
  addProject,
  getProject,
  listProjects,
  removeProject,
  updateProject
} from "@main/db/projects-repo";
import { UserFacingError } from "@main/errors";
import { executeStartWork, previewStartWork, type StartWorkDeps } from "@main/git/start-work";
import type { LogEntry } from "@main/logger";
import type { MonitorService } from "@main/monitor/service";

/** 專案、事件、日誌、分支規則、監視器的 IPC 處理邏輯。與 Electron 無關，所以可以直接單元測試。 */

export interface AppHandlerDeps {
  db: Db;
  monitor: Pick<MonitorService, "reloadProjects" | "pollNow" | "setPaused" | "status">;
  /** 「開工」所需的 git 與版本讀取（測試時可注入假的）。 */
  git: StartWorkDeps;
  log: (entry: LogEntry) => void;
  /** 設定類資料變動後呼叫（觸發備份）。 */
  onConfigChanged: () => void;
}

export interface AppHandlers {
  listProjects(): Project[];
  addProject(input: NormalizedProjectInput): Project;
  updateProject(id: number, patch: Record<string, unknown>): Project;
  removeProject(id: number): void;
  queryEvents(query: EventQuery): EventPage;
  getEvent(id: number): PushEvent | null;
  queryLogs(query: LogQuery): LogPage;
  getMonitorStatus(): MonitorStatus;
  pollNow(id: number): Promise<void>;
  setPaused(paused: boolean): void;
  getBranchRule(scopeId: number): BranchRuleView;
  saveBranchRule(scopeId: number, raw: Record<string, unknown>): BranchRuleView;
  resetBranchRule(scopeId: number): BranchRuleView;
  previewStartWork(projectId: number, input: StartWorkInput): Promise<StartWorkPreview>;
  runStartWork(projectId: number, input: StartWorkInput, expectedBranch: string): Promise<StartWorkResult>;
}

export const createAppHandlers = (deps: AppHandlerDeps): AppHandlers => {
  const { db, monitor } = deps;
  const changed = (): void => {
    monitor.reloadProjects();
    deps.onConfigChanged();
  };

  const requireProject = (id: number): Project => {
    const project = getProject(db, id);
    if (!project) {
      throw new UserFacingError("找不到這個專案");
    }
    return project;
  };

  /** scopeId 0 = 全域預設；其他必須是存在的專案。 */
  const requireScope = (scopeId: number): void => {
    if (scopeId !== GLOBAL_SCOPE) {
      requireProject(scopeId);
    }
  };

  const branchRuleView = (scopeId: number): BranchRuleView => {
    const effective = getEffectiveBranchRule(db, scopeId);
    return {
      template: effective.template,
      versionSource: effective.versionSource,
      exempt: effective.exempt,
      scope: effective.scope,
      hasOwn: getOwnBranchRule(db, scopeId) !== null
    };
  };

  /** 同一個專案同時只能有一個「開工」在跑，避免連點造成兩次 git 操作互相打架。 */
  const startWorkInFlight = new Set<number>();

  return {
    listProjects: () => listProjects(db),

    addProject(input) {
      try {
        const project = addProject(db, input);
        changed();
        return project;
      } catch (error) {
        if (error instanceof DuplicateProjectError) {
          throw new UserFacingError("已經在監視這個 repo 了");
        }
        throw error;
      }
    },

    updateProject(id, patch) {
      const current = requireProject(id);
      // owner／repo 一律取自現有專案（放在 patch 之後覆寫）；其餘欄位用 patch 覆蓋後整體重新驗證。
      const merged = validateProjectInput({
        name: current.name,
        localPath: current.localPath,
        branchFilter: current.branchFilter,
        pollIntervalSec: current.pollIntervalSec,
        mode: current.mode,
        enabled: current.enabled,
        aiEnabled: current.aiEnabled,
        ...patch,
        owner: current.owner,
        repo: current.repo
      });
      if (!merged.ok) {
        throw new UserFacingError(merged.errors.join("、"));
      }
      const updated = updateProject(db, id, merged.value);
      if (!updated) {
        throw new UserFacingError("找不到這個專案");
      }
      changed();
      return updated;
    },

    removeProject(id) {
      removeProject(db, id);
      changed();
    },

    queryEvents: (query) => queryEvents(db, query),
    getEvent: (id) => getEvent(db, id),
    queryLogs: (query) => queryLogs(db, query),
    getMonitorStatus: () => monitor.status(),
    pollNow: (id) => monitor.pollNow(id),
    setPaused: (paused) => monitor.setPaused(paused),

    getBranchRule(scopeId) {
      requireScope(scopeId);
      return branchRuleView(scopeId);
    },

    saveBranchRule(scopeId, raw) {
      requireScope(scopeId);
      const validation = validateBranchRuleInput(raw);
      if (!validation.ok) {
        throw new UserFacingError(validation.errors.join("；"));
      }
      saveBranchRule(db, scopeId, validation.value);
      deps.onConfigChanged();
      return branchRuleView(scopeId);
    },

    resetBranchRule(scopeId) {
      requireScope(scopeId);
      deleteBranchRule(db, scopeId);
      deps.onConfigChanged();
      return branchRuleView(scopeId);
    },

    async previewStartWork(projectId, input) {
      const project = requireProject(projectId);
      return previewStartWork(deps.git, project, getEffectiveBranchRule(db, project.id), input);
    },

    async runStartWork(projectId, input, expectedBranch) {
      const project = requireProject(projectId);
      if (startWorkInFlight.has(projectId)) {
        throw new UserFacingError("這個專案的「開工」正在執行中");
      }
      startWorkInFlight.add(projectId);
      try {
        const result = await executeStartWork(
          deps.git,
          project,
          getEffectiveBranchRule(db, project.id),
          input,
          expectedBranch
        );
        deps.log({
          category: "command",
          level: result.ok ? "info" : "warn",
          message: result.ok ? `${project.name}：開工完成，分支 ${result.branch}` : `${project.name}：開工失敗，${result.message}`,
          detail: { steps: result.steps }
        });
        return result;
      } finally {
        startWorkInFlight.delete(projectId);
      }
    }
  };
};
