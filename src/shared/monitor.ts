/** 監視器狀態的共用型別（渲染層顯示用）。 */

export interface ProjectPollStatus {
  projectId: number;
  lastPolledAt: number | null;
  lastError: string | null;
  nextDueAt: number | null;
  inFlight: boolean;
}

export interface MonitorStatus {
  running: boolean;
  /** 使用者手動暫停。 */
  paused: boolean;
  /** 因 rate limit 暫停到何時（epoch ms）；沒有則為 null。 */
  rateLimitedUntil: number | null;
  projects: ProjectPollStatus[];
}

/** 主程序通知渲染層「有東西變了，請重新讀取」。 */
export interface MonitorChange {
  events: boolean;
  status: boolean;
}
