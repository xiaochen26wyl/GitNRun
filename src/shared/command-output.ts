/** 指令即時輸出的共用型別（主程序推給渲染層）。 */

export type CommandRunStatus = "success" | "failed" | "timeout";

export type CommandOutputEvent =
  | { kind: "start"; runId: string; label: string; at: number }
  | { kind: "line"; runId: string; stream: "stdout" | "stderr" | "system"; text: string; at: number }
  | { kind: "end"; runId: string; status: CommandRunStatus; at: number };

/** 每次執行最多推送多少行到畫面，避免失控的輸出灌爆介面；完整輸出另存日誌（有上限）。 */
export const MAX_LIVE_LINES_PER_RUN = 2000;

// ---------------------------------------------------------------------------
// 渲染層的累積邏輯（純函式）
// ---------------------------------------------------------------------------

export interface LiveRunLine {
  stream: "stdout" | "stderr" | "system";
  text: string;
}

export interface LiveRun {
  runId: string;
  label: string;
  status: "running" | CommandRunStatus;
  lines: LiveRunLine[];
}

export const MAX_LIVE_RUNS = 5;
export const MAX_LINES_KEPT_PER_RUN = 500;

/** 把一批輸出事件套用到目前顯示中的執行清單；只保留最近幾次、每次最近幾百行。 */
export const applyOutputEvents = (runs: readonly LiveRun[], events: readonly CommandOutputEvent[]): LiveRun[] => {
  let next = [...runs];
  for (const event of events) {
    if (event.kind === "start") {
      next = [...next, { runId: event.runId, label: event.label, status: "running" as const, lines: [] }].slice(-MAX_LIVE_RUNS);
      continue;
    }
    next = next.map((run) => {
      if (run.runId !== event.runId) return run;
      if (event.kind === "end") return { ...run, status: event.status };
      return { ...run, lines: [...run.lines, { stream: event.stream, text: event.text }].slice(-MAX_LINES_KEPT_PER_RUN) };
    });
  }
  return next;
};
