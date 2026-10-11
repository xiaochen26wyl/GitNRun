import { useEffect, useState } from "react";
import type { AppInfo } from "@shared/ipc";
import { DocumentsView } from "./DocumentsView";
import { GeneralPanel } from "./GeneralPanel";
import { GitHubView } from "./GitHubView";
import { RunView } from "./RunView";
import logo from "./assets/logo.png";

type Tab = "run" | "documents" | "github" | "settings";

export const App = () => {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [tab, setTab] = useState<Tab>("run");

  useEffect(() => {
    void window.gitNRun.getAppInfo().then(setInfo);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img className="brand-logo" src={logo} alt="" width={28} height={28} />
          <strong>devRun</strong>
          {info ? <span className="muted">v{info.version}</span> : null}
        </div>
        <nav className="tabs" aria-label="主頁籤">
          <button type="button" className={tab === "run" ? "active" : ""} onClick={() => setTab("run")}>
            專案啟動
          </button>
          <button type="button" className={tab === "documents" ? "active" : ""} onClick={() => setTab("documents")}>
            文件空間
          </button>
          <button type="button" className={tab === "github" ? "active" : ""} onClick={() => setTab("github")}>
            Git / GitHub
          </button>
          <button type="button" className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>
            設定
          </button>
        </nav>
      </header>

      <main className="content">
        {tab === "run" ? <RunView /> : null}
        {tab === "documents" ? <DocumentsView /> : null}
        {tab === "github" ? <GitHubView onOpenSettings={() => setTab("settings")} /> : null}
        {tab === "settings" ? <GeneralPanel /> : null}
      </main>
    </div>
  );
};
