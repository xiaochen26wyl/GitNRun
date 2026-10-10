import type { PushEvent } from "@shared/events";
import { PUSH } from "@shared/ipc";
import type { MonitorChange } from "@shared/monitor";
import type { Project } from "@shared/projects";
import { broadcast } from "@main/broadcast";
import { createBranchChecker } from "@main/branch-checker";
import type { Db } from "@main/db/database";
import { createGithubClient } from "@main/github/client";
import { redact } from "@main/log-redaction";
import type { Logger } from "@main/logger";
import { createIngest, type IngestFn } from "@main/monitor/ingest";
import { PollScheduler } from "@main/monitor/scheduler";
import { createMonitorService, type MonitorService } from "@main/monitor/service";
import { createNotifier } from "@main/notifier";
import type { Vault } from "@main/vault/vault";

const changeListeners = new Set<(change: MonitorChange) => void>();

/** 主程序內部的訂閱（例如托盤選單跟著監視狀態更新）；回傳取消訂閱的函式。 */
export const onMonitorChange = (listener: (change: MonitorChange) => void): (() => void) => {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
};

/** 通知所有開著的視窗與內部訂閱者：有新事件或狀態變動。 */
export const emitMonitorChange = (change: MonitorChange): void => {
  broadcast(PUSH.monitorChanged, change);
  for (const listener of changeListeners) {
    listener(change);
  }
};

export interface EventPipelineOptions {
  /** 使用者點擊通知時要做的事（通常是帶出主視窗）。 */
  onNotificationClick: () => void;
  /** 桌面通知之後要處理新事件的下游（例如規則引擎）；各自失敗不影響其他下游。 */
  onNewEvent?: ReadonlyArray<(event: PushEvent, project: Project) => void | Promise<void>>;
}

/**
 * 所有事件（輪詢、Webhook）進來的唯一入口：寫入（冪等）→ 分支命名檢查 → 通知 → 規則引擎。
 * 兩種來源共用同一份，所以同一次推送不管從哪邊先到，都只會處理一次。
 */
export const createEventPipeline = (db: Db, logger: Logger, options: EventPipelineOptions): IngestFn =>
  createIngest({
    db,
    isBranchViolation: createBranchChecker(db),
    onNewEvent: [createNotifier(db, options.onNotificationClick), ...(options.onNewEvent ?? [])],
    onError: (error) => logger.log({ category: "system", level: "warn", message: `事件處理失敗：${redact(error)}` })
  });

/** 組裝輪詢監視器：GitHub token 每次請求才從保險庫取出，用完即丟。 */
export const createMonitorRuntime = (db: Db, vault: Vault, ingest: IngestFn, logger: Logger): MonitorService => {
  const scheduler = new PollScheduler();
  // service 與 client 互相需要（rate limit 回報），用延遲取值解開循環。
  let service: MonitorService | null = null;

  const client = createGithubClient({
    fetchFn: fetch,
    withToken: (fn) => vault.useSecret("github.pat", fn),
    onRateLimit: (info) => service?.onRateLimit(info)
  });

  service = createMonitorService({
    db,
    client,
    scheduler,
    ingest,
    now: Date.now,
    log: (entry) => logger.log(entry),
    emit: emitMonitorChange
  });
  return service;
};
