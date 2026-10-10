import type { PushEvent } from "@shared/events";
import type { Project } from "@shared/projects";
import { eventVariables, expandEventText } from "@shared/rules";
import type { PostJsonFn } from "@main/http-post";
import { formatNotification } from "@main/monitor/notification-text";
import type { ActionExecutors, ActionResult } from "@main/rules/engine";
import { SecretMissingError, SecretUnreadableError } from "@main/vault/vault";

/** 通知類動作：系統通知、Slack、外送 Webhook。 */

export interface NotifyDeps {
  showNotification: (title: string, body: string) => void;
  post: PostJsonFn;
  /** 以保險庫取出 Slack Webhook URL；明文只活在回呼內。 */
  withSlackUrl: <T>(fn: (url: string) => Promise<T>) => Promise<T>;
}

const SLACK_URL_PREFIX = "https://hooks.slack.com/services/";

const fail = (message: string): ActionResult => ({ status: "failed", message });

const defaultText = (event: PushEvent, project: Project): { title: string; body: string } => formatNotification(project, event);

/** 通知用的標題與內文：使用者有寫就用（可帶 {變數}），沒寫就用預設文字。 */
export const notificationText = (
  action: { title?: string; body?: string },
  event: PushEvent,
  project: Project,
  extra: Readonly<Record<string, string>> = {}
): { title: string; body: string } => {
  const fallback = defaultText(event, project);
  // 前面動作的輸出（如 {ai_summary}）也能放進通知文字。
  const variables = { ...eventVariables(event, project), ...extra };
  return {
    title: action.title ? expandEventText(action.title, variables) : fallback.title,
    body: action.body ? expandEventText(action.body, variables) : fallback.body
  };
};

/** 外送 Webhook 的內容：事件摘要，不含任何密鑰。 */
export const webhookPayload = (
  event: PushEvent,
  project: Project,
  includeEvent: boolean,
  outputs: Readonly<Record<string, string>> = {}
): Record<string, unknown> => ({
  source: "gitnrun",
  project: project.name,
  branch: event.branch,
  type: event.eventType,
  ...(Object.keys(outputs).length > 0 ? { outputs } : {}),
  ...(includeEvent
    ? {
        event: {
          ref: event.ref,
          beforeSha: event.beforeSha,
          afterSha: event.afterSha,
          pusher: event.pusher,
          pusherInferred: event.pusherInferred,
          headMessage: event.headMessage,
          commits: event.commits.map((commit) => ({ sha: commit.sha, message: commit.message, author: commit.author })),
          files: event.files,
          occurredAt: event.occurredAt
        }
      }
    : {})
});

/** 只顯示網址的來源與路徑；query 與帳密可能帶有憑證，不顯示、也不記錄。 */
export const describeUrl = (raw: string): string => {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "（網址格式不正確）";
  }
};

const parseWebhookUrl = (raw: string): URL | null => {
  try {
    const url = new URL(raw);
    const okProtocol = url.protocol === "https:" || url.protocol === "http:";
    return okProtocol && url.username === "" && url.password === "" ? url : null;
  } catch {
    return null;
  }
};

export const createNotifyExecutors = (deps: NotifyDeps): Pick<ActionExecutors, "notify_system" | "notify_slack" | "notify_webhook"> => ({
  notify_system: {
    describe: (action, { event, project, variables }) => {
      const { title, body } = notificationText(action, event, project, variables);
      return `顯示系統通知：${title}\n${body}`;
    },
    run: async (action, { event, project, variables }) => {
      const { title, body } = notificationText(action, event, project, variables);
      deps.showNotification(title, body);
      return { status: "success", message: "已顯示系統通知" };
    }
  },

  notify_slack: {
    describe: (action, { event, project, variables }) => {
      const { title, body } = notificationText({ body: action.text }, event, project, variables);
      return `傳送到 Slack：\n${title}\n${body}`;
    },
    run: async (action, { event, project, variables }) => {
      const { title, body } = notificationText({ body: action.text }, event, project, variables);
      try {
        return await deps.withSlackUrl(async (url) => {
          if (!url.startsWith(SLACK_URL_PREFIX)) {
            return fail("Slack Webhook URL 格式不正確");
          }
          const { status } = await deps.post(url, { text: action.text ? body : `*${title}*\n${body}` });
          return status >= 200 && status < 300
            ? ({ status: "success", message: "已傳送到 Slack" } as const)
            : fail(`Slack 回應 HTTP ${status}`);
        });
      } catch (error) {
        if (error instanceof SecretMissingError) return fail("尚未設定 Slack Webhook URL");
        if (error instanceof SecretUnreadableError) return fail("Slack Webhook URL 無法解密，請重新輸入");
        return fail("無法連線到 Slack");
      }
    }
  },

  notify_webhook: {
    describe: (action, { event, project, variables }) => {
      const payload = webhookPayload(event, project, action.includeEvent, variables);
      return `POST 到 ${describeUrl(action.url)}\n內容：${action.includeEvent ? "事件摘要（commit、檔案、推送者）" : "專案與分支名稱"}\n（約 ${JSON.stringify(payload).length} 位元組）`;
    },
    run: async (action, { event, project, variables }) => {
      const url = parseWebhookUrl(action.url);
      if (!url) {
        return fail("Webhook 網址不正確（只允許 http／https，且不可含帳號密碼）");
      }
      try {
        const { status } = await deps.post(url.toString(), webhookPayload(event, project, action.includeEvent, variables));
        return status >= 200 && status < 300
          ? { status: "success", message: `已送出（HTTP ${status}）` }
          : fail(`對方回應 HTTP ${status}`);
      } catch {
        return fail("無法連線到 Webhook 網址");
      }
    }
  }
});
