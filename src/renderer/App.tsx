import { useCallback, useEffect, useState } from "react";
import type { AppInfo } from "@shared/ipc";
import type { MonitorStatus } from "@shared/monitor";
import { EventsView } from "./EventsView";
import { GeneralPanel } from "./GeneralPanel";
import { LogsView } from "./LogsView";
import { ProjectsView } from "./ProjectsView";
import { RulesView } from "./RulesView";
import { RunView } from "./RunView";
import { AiPanel } from "./AiPanel";
import { BranchRulesPanel } from "./BranchRulesPanel";
import { SecretsPanel } from "./SecretsPanel";
import { TerminalView } from "./TerminalView";
import { WebhookPanel } from "./WebhookPanel";
import { formatTimeOfDay } from "@shared/format";
import { useMonitorChanged } from "./hooks";

type TabId = "events" | "projects" | "rules" | "run" | "terminal" | "logs" | "settings";

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: "events", label: "事件" },
  { id: "projects", label: "專案" },
  { id: "rules", label: "規則" },
  { id: "run", label: "專案啟動" },
  { id: "terminal", label: "終端機" },
  { id: "logs", label: "日誌" },
  { id: "settings", label: "設定" }
];

const TOAST_MS = 4_000;

const statusText = (status: MonitorStatus | null): { text: string; tone: "ok" | "warn" | "muted" } => {
  if (!status) return { text: "—", tone: "muted" };
  if (status.paused) return { text: "已暫停", tone: "warn" };
  if (status.rateLimitedUntil) return { text: `GitHub 限流，${formatTimeOfDay(status.rateLimitedUntil)} 後恢復`, tone: "warn" };
  return status.running ? { text: "監視中", tone: "ok" } : { text: "未啟動", tone: "muted" };
};

export const App = () => {
  const [tab, setTab] = useState<TabId>("events");
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [status, setStatus] = useState<MonitorStatus | null>(null);
  const [toast, setToast] = useState("");

  const refreshStatus = useCallback(() => {
    void window.gitNRun.getMonitorStatus().then(setStatus);
  }, []);

  useEffect(() => {
    void window.gitNRun.getAppInfo().then(setInfo);
    refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(""), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  useMonitorChanged((change) => {
    refreshStatus();
    if (change.events) {
      setToast("收到新的推送");
    }
  });

  const monitor = statusText(status);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <strong>GitNRun</strong>
          {info ? <span className="muted">v{info.version}</span> : null}
        </div>
        <nav className="tabs" aria-label="主要分頁">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={tab === entry.id ? "active" : ""}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </nav>
        <div className="monitor-state">
          <span className={monitor.tone}>{monitor.text}</span>
          <button
            type="button"
            onClick={() => void window.gitNRun.setMonitorPaused(!status?.paused).then(refreshStatus)}
          >
            {status?.paused ? "恢復監視" : "暫停監視"}
          </button>
        </div>
      </header>

      {toast ? (
        <div className="toast" role="status">
          {toast}
        </div>
      ) : null}

      <main className="content">
        {tab === "events" ? <EventsView /> : null}
        {tab === "projects" ? <ProjectsView onOpenSettings={() => setTab("settings")} /> : null}
        {tab === "rules" ? <RulesView /> : null}
        {tab === "run" ? <RunView /> : null}
        {tab === "terminal" ? <TerminalView /> : null}
        {tab === "logs" ? <LogsView /> : null}
        {tab === "settings" ? (
          <>
            <GeneralPanel />
            <SecretsPanel />
            <AiPanel />
            <BranchRulesPanel />
            <WebhookPanel />
          </>
        ) : null}
      </main>
    </div>
  );
};
