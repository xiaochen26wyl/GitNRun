import type { Db } from "@main/db/database";
import { getSetting } from "@main/db/settings-repo";

export const NOTIFICATIONS_ENABLED_KEY = "notifications.enabled";
export const NOTIFICATIONS_MUTED_PROJECTS_KEY = "notifications.mutedProjectIds";

export const readMutedProjectIds = (db: Db): number[] => {
  const stored = getSetting<unknown>(db, NOTIFICATIONS_MUTED_PROJECTS_KEY, []);
  return Array.isArray(stored) ? stored.filter((id): id is number => Number.isSafeInteger(id) && id > 0) : [];
};

/** 新事件的桌面通知要不要跳出來：全域開關開著，而且這個專案沒有被靜音。 */
export const isNotificationAllowed = (db: Db, projectId: number): boolean =>
  getSetting<boolean>(db, NOTIFICATIONS_ENABLED_KEY, true) !== false && !readMutedProjectIds(db).includes(projectId);
