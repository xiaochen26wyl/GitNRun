import { useEffect, useState } from "react";
import { applyOutputEvents, type LiveRun } from "@shared/command-output";

const STATUS_TEXT: Record<LiveRun["status"], string> = {
  running: "執行中",
  success: "成功",
  failed: "失敗",
  timeout: "逾時"
};

/** 規則執行指令時的即時輸出（已在主程序脫敏）。沒有執行過任何指令時不佔位置。 */
export const LiveOutput = () => {
  const [runs, setRuns] = useState<LiveRun[]>([]);

  useEffect(() => window.gitNRun.onCommandOutput((events) => setRuns((current) => applyOutputEvents(current, events))), []);

  if (runs.length === 0) {
    return null;
  }

  return (
    <section className="subpanel">
      <div className="project-head">
        <strong>指令即時輸出</strong>
        <button type="button" onClick={() => setRuns([])}>
          清除
        </button>
      </div>
      {[...runs].reverse().map((run) => (
        <div key={run.runId}>
          <div>
            <span className="mono">{run.label}</span>{" "}
            <span className={`badge ${run.status === "failed" || run.status === "timeout" ? "warn-badge" : ""}`}>{STATUS_TEXT[run.status]}</span>
          </div>
          <pre className="output">
            {run.lines.slice(-200).map((line, index) => (
              <span key={index} className={line.stream === "stderr" ? "warn" : line.stream === "system" ? "muted" : undefined}>
                {line.text}
                {"\n"}
              </span>
            ))}
          </pre>
        </div>
      ))}
    </section>
  );
};
