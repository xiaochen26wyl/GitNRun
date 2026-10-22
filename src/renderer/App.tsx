import { useEffect, useState } from "react";
import type { AppInfo } from "@shared/ipc";
import { DEFAULT_RUN_GROUP_ID, RUN_GROUPS, RUN_OTHER_GROUP, runGroupById, type RunGroupId } from "@shared/run-groups";
import { ClaudeView } from "./ClaudeView";
import { GeneralPanel } from "./GeneralPanel";
import { LogsView } from "./LogsView";
import { PortSweepPanel } from "./PortSweepPanel";
import { RunView } from "./RunView";
import { SecretsPanel } from "./SecretsPanel";
import logo from "./assets/logo.png";

type Tab = RunGroupId | "claude" | "settings";

export const App = () => {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [tab, setTab] = useState<Tab>(DEFAULT_RUN_GROUP_ID);
  // 對不到任何分組的專案數；大於 0 才多出「其他」頁籤，避免新專案悄悄消失。
  const [ungrouped, setUngrouped] = useState(0);
  const runGroups = ungrouped > 0 ? [...RUN_GROUPS, RUN_OTHER_GROUP] : RUN_GROUPS;

  useEffect(() => {
    void window.gitNRun.getAppInfo().then(setInfo);
  }, []);

  // 停在「其他」時最後一個未歸類專案不見了，退回第一個分組，不停在空白頁。
  useEffect(() => {
    if (tab === "other" && ungrouped === 0) setTab(DEFAULT_RUN_GROUP_ID);
  }, [tab, ungrouped]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img className="brand-logo" src={logo} alt="" width={28} height={28} />
          <strong>GitNRun</strong>
          {info ? <span className="muted">v{info.version}</span> : null}
        </div>
        <nav className="tabs" aria-label="主頁籤">
          {runGroups.map((group) => (
            <button key={group.id} type="button" className={tab === group.id ? "active" : ""} onClick={() => setTab(group.id)}>
              {group.label}
            </button>
          ))}
          <button type="button" className={tab === "claude" ? "active" : ""} onClick={() => setTab("claude")}>
            Claude
          </button>
          <button type="button" className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>
            設定
          </button>
        </nav>
      </header>

      <main className="content">
        {tab !== "settings" && tab !== "claude" ? <RunView key={tab} group={runGroupById(tab)} onUngroupedCount={setUngrouped} onOpenSettings={() => setTab("settings")} /> : null}
        {tab === "claude" ? <ClaudeView /> : null}
        {tab === "settings" ? (
          <div className="settings-page">
            <PortSweepPanel />
            <GeneralPanel />
            <section className="panel">
              <h2>日誌</h2>
              <LogsView />
            </section>
            <SecretsPanel />
          </div>
        ) : null}
      </main>
    </div>
  );
};
