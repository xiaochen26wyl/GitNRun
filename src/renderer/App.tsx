import { useEffect, useRef, useState } from "react";
import type { AppInfo } from "@shared/ipc";
import { DEFAULT_RUN_GROUP_ID, RUN_GROUPS, RUN_OTHER_GROUP, type RunGroup, MAX_TAB_NAME_CHARS, runGroupById, tabLabelOf, type RunGroupId } from "@shared/run-groups";
import { ClaudeView } from "./ClaudeView";
import { GeneralPanel } from "./GeneralPanel";
import { LogsView } from "./LogsView";
import { PortSweepPanel } from "./PortSweepPanel";
import { RunDataProvider, useRunData } from "./RunDataContext";
import { RunView } from "./RunView";
import { SecretsPanel } from "./SecretsPanel";
import { ViewPrefsProvider, useViewPrefs } from "./ViewPrefsContext";
import logo from "./assets/logo.png";

type Tab = RunGroupId | "claude" | "settings";

export const App = () => (
  <ViewPrefsProvider>
    <RunDataProvider>
      <AppBody />
    </RunDataProvider>
  </ViewPrefsProvider>
);

/** 頁籤標題：雙擊就地改名，Enter／失焦確認，Esc 取消，清空還原預設名稱。 */
const GroupTab = ({ group, active, onSelect }: { group: RunGroup; active: boolean; onSelect: () => void }) => {
  const { tabNames, save } = useViewPrefs();
  const [draft, setDraft] = useState<string | null>(null);
  // 結束編輯後輸入框卸載會再觸發一次 blur；用 ref 擋掉，避免 Esc 取消後又被存下。
  const editing = useRef(false);
  const label = tabLabelOf(group, tabNames);

  const finish = () => {
    editing.current = false;
    setDraft(null);
  };

  const commit = () => {
    if (draft === null || !editing.current) return;
    const name = draft.trim();
    finish();
    if (name === label || (name === "" && label === group.label)) return;
    const { [group.id]: _removed, ...rest } = tabNames;
    save({ tabNames: name === "" ? rest : { ...rest, [group.id]: name } });
  };

  if (draft !== null) {
    return (
      <input
        className="tab-rename"
        autoFocus
        value={draft}
        maxLength={MAX_TAB_NAME_CHARS}
        placeholder={group.label}
        aria-label="頁籤名稱"
        size={Math.max(4, Array.from(draft).length + 1)}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => event.target.select()}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") finish();
        }}
      />
    );
  }
  return (
    <button type="button" className={active ? "active" : ""} title="雙擊可改名" onClick={onSelect} onDoubleClick={() => {
        if (group.id === "other") return;
        editing.current = true;
        setDraft(label);
      }}>
      {label}
    </button>
  );
};

const AppBody = () => {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [tab, setTab] = useState<Tab>(DEFAULT_RUN_GROUP_ID);
  // 對不到任何分組的專案數；大於 0 才多出「其他」頁籤，避免新專案悄悄消失。
  const { ungrouped } = useRunData();
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
            <GroupTab key={group.id} group={group} active={tab === group.id} onSelect={() => setTab(group.id)} />
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
        {tab !== "settings" && tab !== "claude" ? <RunView key={tab} group={runGroupById(tab)} onOpenSettings={() => setTab("settings")} /> : null}
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
