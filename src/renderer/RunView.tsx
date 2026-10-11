import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "@shared/format";
import { type RunAction, type RunButtonState, type RunOverview, type RunServiceState, type RunServiceView, type RunTargetView } from "@shared/run";

const REFRESH_MS = 4_000;

const ROLE_LABEL = { backend: "後端", frontend: "前端", desktop: "桌面" } as const;
const STATE_LABEL: Record<RunServiceState, string> = { running: "執行中", starting: "啟動中", stopped: "未啟動" };

const actionKey = (target: RunTargetView, action: RunAction): string =>
  action.scope === "project" ? `${target.id}:project:${action.action}` : `${target.id}:${action.service}:${action.action}`;

const ActionButton = ({
  label,
  state,
  busy,
  onClick
}: {
  label: string;
  state: RunButtonState;
  busy: boolean;
  onClick: () => void;
}) => (
  <button type="button" disabled={!state.enabled || busy} title={state.reason ?? undefined} onClick={onClick}>
    {label}
  </button>
);

const ServiceRow = ({
  target,
  service,
  busyKey,
  onAction
}: {
  target: RunTargetView;
  service: RunServiceView;
  busyKey: string;
  onAction: (action: RunAction) => void;
}) => {
  const startAction: RunAction = { scope: "service", service: service.name, action: "start" };
  const restartAction: RunAction = { scope: "service", service: service.name, action: "restart" };
  const stopAction: RunAction = { scope: "service", service: service.name, action: "stop" };
  const webAction: RunAction = { scope: "service", service: service.name, action: "web" };
  const hotReloadAction: RunAction = { scope: "service", service: service.name, action: "hot-reload" };
  const hotRestartAction: RunAction = { scope: "service", service: service.name, action: "hot-restart" };
  const busy = (action: RunAction): boolean => busyKey !== "" && busyKey !== actionKey(target, action);

  return (
    <li className="run-service">
      <div className="run-service-main">
        <span className={`status-dot ${service.state}`} title={STATE_LABEL[service.state]} />
        <strong>{service.name}</strong>
        <span className="badge">{ROLE_LABEL[service.role]}</span>
        {service.hotReloadable ? <span className="badge">Flutter</span> : null}
        <span className="muted">{STATE_LABEL[service.state]}</span>
        {service.url ? <span className="mono">{service.url}</span> : null}
      </div>
      <span className="muted mono run-command">{service.command}</span>
      <div className="row-actions run-service-actions">
        <ActionButton label={service.role === "desktop" ? "開桌面" : "啟動"} state={service.buttons.start} busy={busy(startAction)} onClick={() => onAction(startAction)} />
        <ActionButton label="重新啟動" state={service.buttons.restart} busy={busy(restartAction)} onClick={() => onAction(restartAction)} />
        {service.buttons.stop.enabled ? <ActionButton label="停止" state={service.buttons.stop} busy={busy(stopAction)} onClick={() => onAction(stopAction)} /> : null}
        {service.role === "frontend" ? <ActionButton label="開網頁" state={service.buttons.web} busy={busy(webAction)} onClick={() => onAction(webAction)} /> : null}
        {service.hotReloadable ? (
          <>
            <ActionButton label="熱更新 r" state={service.buttons.hotReload} busy={busy(hotReloadAction)} onClick={() => onAction(hotReloadAction)} />
            <ActionButton label="熱啟動 R" state={service.buttons.hotRestart} busy={busy(hotRestartAction)} onClick={() => onAction(hotRestartAction)} />
          </>
        ) : null}
      </div>
    </li>
  );
};

const TargetRow = ({
  target,
  busyKey,
  onAction,
  onRemove
}: {
  target: RunTargetView;
  busyKey: string;
  onAction: (action: RunAction) => void;
  onRemove: () => void;
}) => (
  <li className="project-row run-row">
    <div className="project-head">
      <div className="run-project-title">
        <strong>{target.label}</strong>
        {target.buttons.stop.enabled ? (
          <ActionButton
            label="停止全部"
            state={target.buttons.stop}
            busy={busyKey !== "" && busyKey !== actionKey(target, { scope: "project", action: "stop" })}
            onClick={() => onAction({ scope: "project", action: "stop" })}
          />
        ) : null}
      </div>
      <span className="muted mono">{target.folder}</span>
      {target.manifest === "ok" && !target.trusted ? <span className="badge" title="第一次執行時會先請你確認指令">指令未確認</span> : null}
      {target.manifest === "invalid" ? <span className="warn-badge">啟動設定有誤</span> : null}
    </div>

    {target.manifest === "missing" ? (
      <p className="muted">目前在 package.json 找不到 dev、web、frontend、api、backend 或 desktop 這類可啟動 script。</p>
    ) : null}
    {target.errors.length > 0 ? (
      <ul className="plain-list warn">
        {target.errors.slice(0, 5).map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
    ) : null}

    {target.services.length > 0 ? (
      <ul className="plain-list run-services">
        {target.services.map((service) => (
          <ServiceRow key={service.name} target={target} service={service} busyKey={busyKey} onAction={onAction} />
        ))}
      </ul>
    ) : null}

    <div className="row-actions run-buttons">
      {target.source === "folder" ? (
        <button type="button" onClick={onRemove}>
          移除
        </button>
      ) : null}
    </div>
  </li>
);

export const RunView = () => {
  const [overview, setOverview] = useState<RunOverview | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const hasTargets = (overview?.targets.length ?? 0) > 0;

  const refresh = useCallback(() => {
    void window.gitNRun
      .getRunOverview()
      .then(setOverview)
      .catch((refreshError) => setError(errorMessage(refreshError)));
  }, []);

  // 分頁可見時才定期刷新狀態；離開這個分頁元件就卸載，輪詢隨之停止。
  useEffect(() => {
    refresh();
    const timer = setInterval(() => {
      if (!document.hidden) refresh();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const act = async (target: RunTargetView, action: RunAction) => {
    setError("");
    setBusyKey(actionKey(target, action));
    try {
      const result = await window.gitNRun.runProjectAction(target.id, action);
      setMessage({ ok: result.ok, text: `${target.label}：${result.message}` });
    } catch (actionError) {
      setMessage(null);
      setError(errorMessage(actionError));
    } finally {
      setBusyKey("");
      refresh();
    }
  };

  return (
    <section>
      <div className="run-hero">
        <h1>選一個專案，按一下跑前後端</h1>
        <p className="muted">已設定本機路徑的專案會列在這裡；GitNRun 會從 package.json scripts 自動找出可啟動服務。</p>
      </div>
      <p className="muted">
        按下按鈕才會啟動；port 會在當下配置。要停止服務，關掉對應的 iTerm2 分頁或按 Ctrl+C。
        {overview && !overview.iterm ? <span className="warn"> 找不到 iTerm2，啟動類按鈕無法使用。</span> : null}
      </p>

      {overview && !hasTargets ? (
        <p className="empty muted">沒有可啟動的專案。專案只要在 Git / GitHub 頁籤設定本機路徑，就會自動出現在這裡。</p>
      ) : null}

      {message ? <p className={message.ok ? "ok" : "warn"}>{message.text}</p> : null}
      {error ? <p className="warn">{error}</p> : null}

      {overview === null ? <p className="muted">載入中…</p> : null}
      {hasTargets ? (
        <div className="section-head run-list-head">
          <div>
            <h2>專案清單</h2>
            <p className="muted">每個專案會自動顯示 package.json 裡可執行的本機服務。</p>
          </div>
        </div>
      ) : null}
      <ul className="project-list">
        {overview?.targets.map((target) => (
          <TargetRow
            key={target.id}
            target={target}
            busyKey={busyKey}
            onAction={(action) => void act(target, action)}
            onRemove={() =>
              void window.gitNRun
                .removeRunFolder(target.id)
                .then(refresh)
                .catch((removeError) => setError(errorMessage(removeError)))
            }
          />
        ))}
      </ul>
    </section>
  );
};
