import { Notification } from "electron";
import type { PushEvent } from "@shared/events";
import type { Project } from "@shared/projects";
import type { Db } from "@main/db/database";
import { formatNotification } from "@main/monitor/notification-text";
import { isNotificationAllowed } from "@main/notification-prefs";

/** 顯示一則桌面通知；系統不支援時回傳 false。 */
export const showDesktopNotification = (title: string, body: string, onClick?: () => void): boolean => {
  if (!Notification.isSupported()) {
    return false;
  }
  const notification = new Notification({ title, body });
  if (onClick) {
    notification.on("click", onClick);
  }
  notification.show();
  return true;
};

/** 新事件的桌面通知；使用者可以整體關閉，或針對個別專案靜音。點擊通知會帶出主視窗。 */
export const createNotifier =
  (db: Db, onClick: () => void) =>
  (event: PushEvent, project: Project): void => {
    if (!isNotificationAllowed(db, project.id)) {
      return;
    }
    const { title, body } = formatNotification(project, event);
    showDesktopNotification(title, body, onClick);
  };
