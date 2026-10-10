import type { PushEvent } from "@shared/events";
import type { Project } from "@shared/projects";

export interface NotificationText {
  title: string;
  body: string;
}

/** 桌面通知的文字（純函式）。 */
export const formatNotification = (project: Pick<Project, "name">, event: PushEvent): NotificationText => {
  const title = `${project.name} · ${event.branch}`;
  let body: string;

  if (event.eventType === "delete") {
    body = "分支已被刪除";
  } else if (event.eventType === "create") {
    body = event.headMessage ? `新分支：${event.headMessage}` : "新分支";
  } else {
    const who = event.pusher ? `${event.pusher}${event.pusherInferred ? "（推定）" : ""}` : "有人";
    const subject = event.headMessage || `${event.fileCount} 個檔案變更`;
    const more = event.commits.length > 1 ? `（共 ${event.commits.length} 個 commit）` : "";
    body = `${who}：${subject}${more}`;
  }

  return { title, body: event.branchViolation ? `⚠ 分支名稱不符規則\n${body}` : body };
};
