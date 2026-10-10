import type { NewPushEvent, PushEvent } from "@shared/events";
import type { Project } from "@shared/projects";
import type { Db } from "@main/db/database";
import { getEvent, insertEvent, type InsertResult } from "@main/db/events-repo";

/**
 * 單一事件入口（ingestion pipeline）：輪詢與 Webhook 兩種來源都從這裡進來。
 * 寫入（冪等）→ 若是新事件才通知並交給規則引擎。重複事件（另一個來源已經記錄過）
 * 不會再通知、不會再觸發規則。
 */

export interface IngestDeps {
  db: Db;
  /** 分支名稱是否違反命名規則；分支命名規則（變更要求 5）接上後提供。 */
  isBranchViolation?: (project: Project, branch: string) => boolean;
  /** 新事件的下游處理：桌面通知、規則引擎。個別失敗不影響其他下游與寫入結果。 */
  onNewEvent?: ReadonlyArray<(event: PushEvent, project: Project) => void | Promise<void>>;
  onError?: (error: unknown) => void;
}

export type IngestFn = (project: Project, event: NewPushEvent) => Promise<InsertResult>;

export const createIngest =
  (deps: IngestDeps): IngestFn =>
  async (project, event) => {
    const violation =
      event.eventType !== "delete" && (deps.isBranchViolation?.(project, event.branch) ?? false);
    const result = insertEvent(deps.db, { ...event, branchViolation: violation });

    if (result.inserted) {
      const stored = getEvent(deps.db, result.id);
      if (stored) {
        for (const handler of deps.onNewEvent ?? []) {
          try {
            await handler(stored, project);
          } catch (error) {
            deps.onError?.(error);
          }
        }
      }
    }
    return result;
  };
