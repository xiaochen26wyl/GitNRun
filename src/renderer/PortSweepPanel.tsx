import { useState } from "react";
import { errorMessage } from "@shared/format";
import type { PortSweepResult, SweepTarget } from "@shared/port-sweep";
import { HelpTip } from "./HelpTip";

type Phase = { kind: "idle" } | { kind: "scanning" } | { kind: "confirm"; targets: SweepTarget[] } | { kind: "releasing" };
type Notice = { tone: "ok" | "error"; text: string };

const portLabel = (target: SweepTarget): string => target.ports.map((port) => `:${port}`).join(" ");
const describe = (targets: readonly SweepTarget[]): string => targets.map((target) => `${target.command} ${portLabel(target)}`).join("、");
const portCount = (targets: readonly SweepTarget[]): number => targets.reduce((sum, target) => sum + target.ports.length, 0);

const summarize = (result: PortSweepResult): Notice => {
  if (result.ended.length === 0 && result.failed.length === 0) return { tone: "ok", text: "目前沒有終端機開著的 port" };
  const ended = result.ended.length > 0 ? `已釋放 ${portCount(result.ended)} 個 port：${describe(result.ended)}` : "";
  const failed = result.failed.length > 0 ? `以下程序仍無法結束：${describe(result.failed)}` : "";
  return { tone: result.failed.length > 0 ? "error" : "ok", text: [ended, failed].filter((part) => part !== "").join("\n") };
};

/** 設定頁：一鍵結束所有在終端機手動開的 port；先列出會結束的程序，確認後才動手。 */
export const PortSweepPanel = () => {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [notice, setNotice] = useState<Notice | null>(null);
  const busy = phase.kind === "scanning" || phase.kind === "releasing";

  const scan = async () => {
    setNotice(null);
    setPhase({ kind: "scanning" });
    try {
      const { targets } = await window.gitNRun.scanTerminalPorts();
      if (targets.length === 0) {
        setNotice({ tone: "ok", text: "目前沒有終端機開著的 port" });
        setPhase({ kind: "idle" });
        return;
      }
      setPhase({ kind: "confirm", targets });
    } catch (scanError) {
      setNotice({ tone: "error", text: errorMessage(scanError) });
      setPhase({ kind: "idle" });
    }
  };

  const release = async () => {
    setNotice(null);
    setPhase({ kind: "releasing" });
    try {
      setNotice(summarize(await window.gitNRun.releaseTerminalPorts()));
    } catch (releaseError) {
      setNotice({ tone: "error", text: errorMessage(releaseError) });
    } finally {
      setPhase({ kind: "idle" });
    }
  };

  return (
    <section className="panel">
      <div className="settings-heading">
        <h2>終端機 port</h2>
        <HelpTip label="終端機 port 說明">
          <p>手動在終端機開的 dev server 沒關乾淨，port 會一直被占用。這顆按鈕一次結束它們。</p>
          <p>
            只會結束同時符合下列條件的程序：你自己的帳號、從終端機啟動、不是 GitNRun 本身。資料庫、Docker、系統服務等沒有終端機的背景程序不會動。按下後先列出清單，確認才結束；程序先收到正常終止訊號，3
            秒後仍不退出才強制結束。
          </p>
        </HelpTip>
      </div>
      <div className="row-actions">
        {phase.kind === "confirm" ? (
          <>
            <button type="button" className="danger" onClick={() => void release()}>
              確定全部結束（{portCount(phase.targets)} 個 port）
            </button>
            <button type="button" onClick={() => setPhase({ kind: "idle" })}>
              取消
            </button>
          </>
        ) : (
          <button type="button" disabled={busy} onClick={() => void scan()}>
            {phase.kind === "scanning" ? "掃描中…" : phase.kind === "releasing" ? "結束中…" : "釋放所有終端機 port"}
          </button>
        )}
      </div>
      {notice ? <p className={notice.tone === "ok" ? "ok pre-line" : "warn pre-line"}>{notice.text}</p> : null}
      {phase.kind === "confirm" ? (
        <ul className="plain-list">
          {phase.targets.map((target) => (
            <li key={target.pid} className="row-actions">
              <span className="mono">{portLabel(target)}</span>
              <span>{target.command}</span>
              <span className="muted">pid {target.pid}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
};
