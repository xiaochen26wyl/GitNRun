import type { MonitorChange, MonitorStatus } from "@shared/monitor";
import type { Db } from "@main/db/database";
import { getPollMeta, savePollMeta } from "@main/db/poll-state-repo";
import { getProject, listProjects } from "@main/db/projects-repo";
import { GithubApiError, type GithubClient, type RateLimitInfo } from "@main/github/client";
import type { LogEntry } from "@main/logger";
import type { IngestFn } from "@main/monitor/ingest";
import { pollProject } from "@main/monitor/poller";
import type { FailureKind, PollScheduler } from "@main/monitor/scheduler";
import { SecretMissingError, SecretUnreadableError } from "@main/vault/vault";

export const TICK_INTERVAL_MS = 1_000;
const MIN_RATE_LIMIT_PAUSE_MS = 60_000;
const MAX_RATE_LIMIT_PAUSE_MS = 60 * 60 * 1000;

export interface MonitorServiceDeps {
  db: Db;
  client: GithubClient;
  scheduler: PollScheduler;
  ingest: IngestFn;
  now: () => number;
  log: (entry: LogEntry) => void;
  emit: (change: MonitorChange) => void;
}

export interface MonitorService {
  start(): void;
  stop(): void;
  /** 一次排程檢查；回傳的 Promise 在這一輪啟動的輪詢全部結束後完成（測試用）。 */
  tick(): Promise<void>;
  reloadProjects(): void;
  pollNow(projectId: number): Promise<void>;
  setPaused(paused: boolean): void;
  status(): MonitorStatus;
  /** 把 GitHub 回報的 rate limit 餵給排程。 */
  onRateLimit(info: RateLimitInfo): void;
}

interface Classified {
  kind: FailureKind;
  message: string;
}

/** 對使用者顯示的訊息一律是固定文字，不夾帶任何請求細節。 */
export const classifyPollError = (error: unknown): Classified => {
  if (error instanceof SecretMissingError) {
    return { kind: "no-token", message: "尚未設定 GitHub Token" };
  }
  if (error instanceof SecretUnreadableError) {
    return { kind: "no-token", message: "GitHub Token 無法解密，請重新輸入" };
  }
  if (error instanceof GithubApiError) {
    switch (error.kind) {
      case "auth":
        return { kind: "auth", message: "GitHub Token 無效或已過期" };
      case "forbidden":
        return { kind: "forbidden", message: "Token 沒有這個 repo 的存取權限" };
      case "not-found":
        return { kind: "not-found", message: "找不到這個 repo，或 Token 無權存取" };
      case "rate-limited":
        return { kind: "other", message: "已達 GitHub rate limit，暫停輪詢" };
      case "server":
        return { kind: "server", message: "GitHub 暫時無法回應" };
      case "network":
        return { kind: "network", message: "無法連線到 GitHub" };
      default:
        return { kind: "other", message: "GitHub 回應內容無法解析" };
    }
  }
  return { kind: "other", message: "輪詢失敗" };
};

export const createMonitorService = (deps: MonitorServiceDeps): MonitorService => {
  const { db, scheduler } = deps;
  let timer: NodeJS.Timeout | null = null;
  let userPaused = false;
  /** 每個專案最近一次已記錄的錯誤種類，避免同一個問題每次輪詢都寫一筆日誌。 */
  const lastLoggedError = new Map<number, string>();

  const reloadProjects = (): void => {
    const wanted = new Set<number>();
    for (const project of listProjects(db)) {
      // 只有 Webhook 模式的專案不輪詢。
      if (project.enabled && project.mode !== "webhook") {
        wanted.add(project.id);
        scheduler.upsert(project.id, project.pollIntervalSec, deps.now());
      }
    }
    for (const { projectId } of scheduler.snapshot()) {
      if (!wanted.has(projectId)) {
        scheduler.remove(projectId);
      }
    }
  };

  const handleFailure = (projectId: number, projectName: string, error: unknown): void => {
    const now = deps.now();
    const { kind, message } = classifyPollError(error);

    if (error instanceof GithubApiError && error.kind === "rate-limited") {
      const wait = Math.min(Math.max(error.retryAfterMs ?? MIN_RATE_LIMIT_PAUSE_MS, MIN_RATE_LIMIT_PAUSE_MS), MAX_RATE_LIMIT_PAUSE_MS);
      scheduler.pauseUntil(now + wait);
    }

    scheduler.fail(projectId, now, kind);
    savePollMeta(db, projectId, { lastPolledAt: now, lastError: message });

    const key = `${kind}:${message}`;
    const changed = lastLoggedError.get(projectId) !== key;
    if (changed) {
      lastLoggedError.set(projectId, key);
      deps.log({ category: "push", level: "warn", message: `${projectName}：${message}` });
    }
    deps.emit({ events: false, status: true });
  };

  const runOne = async (projectId: number): Promise<void> => {
    const project = getProject(db, projectId);
    if (!project || !project.enabled || project.mode === "webhook") {
      scheduler.remove(projectId);
      return;
    }

    try {
      const outcome = await pollProject(
        { db, client: deps.client, ingest: deps.ingest, now: deps.now },
        project
      );
      scheduler.complete(projectId, deps.now());

      const hadError = lastLoggedError.delete(projectId);
      if (outcome.baselined) {
        deps.log({ category: "push", level: "info", message: `${project.name}：已建立監視基準` });
      }
      if (outcome.eventsInserted > 0 || outcome.baselined || hadError) {
        deps.emit({ events: outcome.eventsInserted > 0, status: true });
      }
    } catch (error) {
      handleFailure(projectId, project.name, error);
    }
  };

  const tick = async (): Promise<void> => {
    if (userPaused) {
      return;
    }
    const due = scheduler.takeDue(deps.now());
    await Promise.all(due.map(runOne));
  };

  return {
    start() {
      if (timer) {
        return;
      }
      reloadProjects();
      timer = setInterval(() => void tick(), TICK_INTERVAL_MS);
      timer.unref();
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },

    tick,
    reloadProjects,

    async pollNow(projectId) {
      reloadProjects();
      if (scheduler.acquire(projectId)) {
        await runOne(projectId);
      }
    },

    setPaused(paused) {
      userPaused = paused;
      deps.emit({ events: false, status: true });
    },

    status() {
      const now = deps.now();
      const entries = new Map(scheduler.snapshot().map((entry) => [entry.projectId, entry]));
      return {
        running: timer !== null,
        paused: userPaused,
        rateLimitedUntil: scheduler.isPaused(now) ? scheduler.getPausedUntil() : null,
        projects: listProjects(db).map((project) => {
          const meta = getPollMeta(db, project.id);
          const entry = entries.get(project.id);
          return {
            projectId: project.id,
            lastPolledAt: meta.lastPolledAt,
            lastError: meta.lastError,
            nextDueAt: entry?.nextDueAt ?? null,
            inFlight: entry?.inFlight ?? false
          };
        })
      };
    },

    onRateLimit(info) {
      scheduler.applyRateLimit(info, deps.now());
    }
  };
};
