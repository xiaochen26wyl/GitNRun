import type { RateLimitInfo } from "@main/github/client";

/**
 * 輪詢排程（純邏輯，時間與亂數都由外部注入，方便測試）。
 *
 * - 每個專案各有下次到期時間；到期的才會被取出，並受並行上限限制。
 * - 成功後依專案間隔（±10% 抖動）排下一次；失敗以指數退避。
 * - rate limit 剩餘量低時放慢全部專案，耗盡時全部暫停到重置時間。
 */

export const DEFAULT_CONCURRENCY = 4;
const JITTER_RATIO = 0.1;
const MAX_BACKOFF_MS = 10 * 60 * 1000;
const FIXED_FAILURE_DELAY_MS = 5 * 60 * 1000;
const MAX_RATE_LIMIT_PAUSE_MS = 60 * 60 * 1000;
const MAX_STAGGER_MS = 5_000;

export type FailureKind = "network" | "server" | "auth" | "forbidden" | "not-found" | "no-token" | "other";

export interface SchedulerOptions {
  concurrency?: number;
  random?: () => number;
}

interface Entry {
  intervalSec: number;
  nextDueAt: number;
  failures: number;
  inFlight: boolean;
}

export interface SchedulerSnapshotEntry {
  projectId: number;
  nextDueAt: number;
  failures: number;
  inFlight: boolean;
}

export class PollScheduler {
  private readonly entries = new Map<number, Entry>();
  private readonly concurrency: number;
  private readonly random: () => number;
  private pausedUntil = 0;
  private stretch = 1;

  constructor(options: SchedulerOptions = {}) {
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.random = options.random ?? Math.random;
  }

  /** 登記或更新專案；新登記的專案錯開啟動時間，避免全部同時打出去。 */
  upsert(projectId: number, intervalSec: number, now: number): void {
    const existing = this.entries.get(projectId);
    if (existing) {
      existing.intervalSec = intervalSec;
      return;
    }
    const stagger = this.random() * Math.min(intervalSec * 1000, MAX_STAGGER_MS);
    this.entries.set(projectId, { intervalSec, nextDueAt: now + stagger, failures: 0, inFlight: false });
  }

  remove(projectId: number): void {
    this.entries.delete(projectId);
  }

  /** 使用者按「立即檢查」：不等間隔，下一次 tick 就取出。 */
  forceDue(projectId: number, now: number): void {
    const entry = this.entries.get(projectId);
    if (entry && !entry.inFlight) {
      entry.nextDueAt = now;
    }
  }

  pauseUntil(timestamp: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, timestamp);
  }

  clearPause(): void {
    this.pausedUntil = 0;
  }

  isPaused(now: number): boolean {
    return now < this.pausedUntil;
  }

  getPausedUntil(): number {
    return this.pausedUntil;
  }

  /** 依 GitHub 回報的剩餘額度調整速度；額度耗盡就暫停到重置時間。 */
  applyRateLimit(info: RateLimitInfo, now: number): void {
    if (info.remaining === null) {
      return;
    }
    if (info.remaining <= 10) {
      const resetAt = info.resetAt ?? now + 60_000;
      this.pauseUntil(Math.min(Math.max(resetAt, now), now + MAX_RATE_LIMIT_PAUSE_MS));
      this.stretch = 4;
    } else if (info.remaining < 100) {
      this.stretch = 4;
    } else if (info.remaining < 500) {
      this.stretch = 2;
    } else {
      this.stretch = 1;
    }
  }

  getStretch(): number {
    return this.stretch;
  }

  /** 取出到期且有空位的專案（暫停中不取）；取出即標記為進行中。 */
  takeDue(now: number): number[] {
    if (this.isPaused(now)) {
      return [];
    }
    let inFlight = 0;
    for (const entry of this.entries.values()) {
      if (entry.inFlight) {
        inFlight += 1;
      }
    }
    const slots = this.concurrency - inFlight;
    if (slots <= 0) {
      return [];
    }

    const due = [...this.entries.entries()]
      .filter(([, entry]) => !entry.inFlight && entry.nextDueAt <= now)
      .sort((a, b) => a[1].nextDueAt - b[1].nextDueAt)
      .slice(0, slots);
    for (const [, entry] of due) {
      entry.inFlight = true;
    }
    return due.map(([id]) => id);
  }

  /** 手動「立即檢查」用：不受暫停與到期時間限制，但仍避免同一專案同時跑兩次。 */
  acquire(projectId: number): boolean {
    const entry = this.entries.get(projectId);
    if (!entry || entry.inFlight) {
      return false;
    }
    entry.inFlight = true;
    return true;
  }

  complete(projectId: number, now: number): void {
    const entry = this.entries.get(projectId);
    if (!entry) {
      return;
    }
    entry.inFlight = false;
    entry.failures = 0;
    const jitter = 1 + (this.random() * 2 - 1) * JITTER_RATIO;
    entry.nextDueAt = now + entry.intervalSec * 1000 * this.stretch * jitter;
  }

  fail(projectId: number, now: number, kind: FailureKind): void {
    const entry = this.entries.get(projectId);
    if (!entry) {
      return;
    }
    entry.inFlight = false;
    entry.failures += 1;
    entry.nextDueAt = now + failureDelayMs(kind, entry.failures, entry.intervalSec) * this.stretch;
  }

  snapshot(): SchedulerSnapshotEntry[] {
    return [...this.entries.entries()].map(([projectId, entry]) => ({
      projectId,
      nextDueAt: entry.nextDueAt,
      failures: entry.failures,
      inFlight: entry.inFlight
    }));
  }
}

/** 網路／伺服器問題指數退避；權限、找不到這類不會自己好的問題固定隔較久再試。 */
export const failureDelayMs = (kind: FailureKind, failures: number, intervalSec: number): number => {
  switch (kind) {
    case "auth":
    case "forbidden":
    case "not-found":
      return FIXED_FAILURE_DELAY_MS;
    case "no-token":
      return 30_000;
    default: {
      const base = Math.max(intervalSec * 1000, 15_000);
      return Math.min(base * 2 ** (failures - 1), MAX_BACKOFF_MS);
    }
  }
};
