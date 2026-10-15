import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "@shared/format";
import { useProjectHead, type ProjectHeadAttrs } from "./hooks";
import {
  MOBILE_PLATFORM_LABEL,
  RUN_STATE_LABEL,
  displayServiceName,
  groupRunServices,
  mobilePlatformOf,
  planMobileStop,
  summarizeMobileState,
  type MobilePlatform,
  type RunAction,
  type RunButtonState,
  type RunOverview,
  type RunServiceState,
  type RunServiceView,
  type RunTargetView
} from "@shared/run";
import { countUngroupedRunTargets, targetsOfRunGroup, type RunGroup } from "@shared/run-groups";

const REFRESH_MS = 4_000;
const COPY_FLASH_MS = 1_500;

const ROLE_LABEL = { backend: "後端", frontend: "前端", desktop: "桌面" } as const;
const STATE_LABEL = RUN_STATE_LABEL;
const PLATFORM_LABEL = MOBILE_PLATFORM_LABEL;

const ENABLED: RunButtonState = { enabled: true, reason: null };

/** 標籤優先顯示偵測到的框架，辨識不出來才退回角色。 */
const serviceBadgeLabel = (service: RunServiceView): string =>
  service.framework ?? (mobilePlatformOf(service.name) !== null ? "手機" : ROLE_LABEL[service.role]);

const startLabel = (service: RunServiceView): string => {
  const platform = mobilePlatformOf(service.name);
  if (platform !== null) return `啟動 ${PLATFORM_LABEL[platform]}`;
  return service.role === "desktop" ? "開桌面" : "啟動";
};

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

type CopyState = "idle" | "copied" | "failed";

/** 點下去就複製指令，並展開浮層讓人看到複製了什麼。 */
const CommandButton = ({ command, label = "指令" }: { command: string; label?: string }) => {
  const [open, setOpen] = useState(false);
  const [copy, setCopy] = useState<CopyState>("idle");
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const flash = (next: CopyState): void => {
    setCopy(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopy("idle"), COPY_FLASH_MS);
  };

  const onClick = (): void => {
    setOpen((value) => !value);
    // 包一層 Promise：剪貼簿不可用時同步丟出的錯誤也會走到失敗分支。
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(command))
      .then(
        () => flash("copied"),
        () => flash("failed")
      );
  };

  return (
    <span className="run-command-wrap" ref={ref}>
      <button type="button" aria-expanded={open} onClick={onClick}>
        {copy === "copied" ? "已複製" : copy === "failed" ? "複製失敗" : label}
      </button>
      {open ? <code className="run-command-pop mono">{command}</code> : null}
    </span>
  );
};

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
  const busy = (action: RunAction): boolean => busyKey !== "" && busyKey !== actionKey(target, action);

  return (
    <li className="run-service">
      <div className="run-service-main">
        <span className={`status-dot ${service.state}`} title={STATE_LABEL[service.state]} />
        <span className="run-service-title">{displayServiceName(service.name)}</span>
        <span className="badge run-framework">{serviceBadgeLabel(service)}</span>
        <span className="muted">{STATE_LABEL[service.state]}</span>
        {service.url ? <span className="mono">{service.url}</span> : null}
      </div>
      <div className="row-actions run-service-actions">
        <ActionButton label={startLabel(service)} state={service.buttons.start} busy={busy(startAction)} onClick={() => onAction(startAction)} />
        <ActionButton label="重新啟動" state={service.buttons.restart} busy={busy(restartAction)} onClick={() => onAction(restartAction)} />
        {service.buttons.stop.enabled ? <ActionButton label="結束" state={service.buttons.stop} busy={busy(stopAction)} onClick={() => onAction(stopAction)} /> : null}
        {service.role === "frontend" ? <ActionButton label="開網頁" state={service.buttons.web} busy={busy(webAction)} onClick={() => onAction(webAction)} /> : null}
        <CommandButton command={service.command} />
      </div>
    </li>
  );
};

/** 同一個 App 的 iOS、Android 手機服務合併成一列，標題是去掉平台後的 App 名稱：啟動各平台分開，結束共用一顆，依哪個平台在跑切換文字與對象。 */
const MobileRow = ({
  target,
  title,
  entries,
  busyKey,
  onAction
}: {
  target: RunTargetView;
  title: string;
  entries: Array<{ platform: MobilePlatform; service: RunServiceView }>;
  busyKey: string;
  onAction: (action: RunAction | readonly RunAction[]) => void;
}) => {
  const busy = (action: RunAction): boolean => busyKey !== "" && busyKey !== actionKey(target, action);
  const serviceOf = (platform: MobilePlatform): RunServiceView | undefined => entries.find((entry) => entry.platform === platform)?.service;
  const stopActionOf = (platform: MobilePlatform): RunAction => ({ scope: "service", service: serviceOf(platform)?.name ?? "", action: "stop" });
  const stopPlan = planMobileStop({
    ios: serviceOf("ios")?.buttons.stop.enabled === true,
    android: serviceOf("android")?.buttons.stop.enabled === true
  });
  const stopActions = stopPlan?.platforms.map(stopActionOf) ?? [];
  const summary = summarizeMobileState(entries.map(({ platform, service }) => ({ platform, state: service.state })));
  const first = entries[0]?.service;

  return (
    <li className="run-service">
      <div className="run-service-main">
        <span className={`status-dot ${summary.state}`} title={summary.text} />
        <span className="run-service-title">{displayServiceName(title)}</span>
        <span className="badge run-framework">{first === undefined ? "手機" : serviceBadgeLabel(first)}</span>
        <span className="muted">{summary.text}</span>
      </div>
      <div className="row-actions run-service-actions">
        {entries.map(({ platform, service }) => {
          const name = PLATFORM_LABEL[platform];
          const startAction: RunAction = { scope: "service", service: service.name, action: "start" };
          const restartAction: RunAction = { scope: "service", service: service.name, action: "restart" };
          return (
            <span className="run-platform" key={service.name}>
              <ActionButton label={`啟動 ${name}`} state={service.buttons.start} busy={busy(startAction)} onClick={() => onAction(startAction)} />
              {service.buttons.restart.enabled ? (
                <ActionButton label={`重新啟動 ${name}`} state={service.buttons.restart} busy={busy(restartAction)} onClick={() => onAction(restartAction)} />
              ) : null}
            </span>
          );
        })}
        {stopPlan !== null && stopActions[0] !== undefined ? (
          <ActionButton label={stopPlan.label} state={ENABLED} busy={busy(stopActions[0])} onClick={() => onAction(stopActions)} />
        ) : null}
        {entries.map(({ platform, service }) => (
          <CommandButton key={service.name} command={service.command} label={`${PLATFORM_LABEL[platform]} 指令`} />
        ))}
      </div>
    </li>
  );
};

const TargetRow = ({
  target,
  busyKey,
  headProps,
  onAction
}: {
  target: RunTargetView;
  busyKey: string;
  headProps: (path: string) => ProjectHeadAttrs;
  onAction: (action: RunAction | readonly RunAction[]) => void;
}) => (
  <li className="project-row run-row">
    <div {...headProps(target.folder)}>
      <div className="run-project-title">
        <strong>{target.label}</strong>
        <ActionButton
          label="README"
          state={target.readme}
          busy={busyKey !== "" && busyKey !== actionKey(target, { scope: "project", action: "readme" })}
          onClick={() => onAction({ scope: "project", action: "readme" })}
        />
        {target.buttons.stop.enabled ? (
          <ActionButton
            label="結束全部"
            state={target.buttons.stop}
            busy={busyKey !== "" && busyKey !== actionKey(target, { scope: "project", action: "stop" })}
            onClick={() => onAction({ scope: "project", action: "stop" })}
          />
        ) : null}
      </div>
      <span className="muted mono">{target.folder}</span>
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
        {groupRunServices(target.services).map((row) =>
          row.kind === "mobile" ? (
            <MobileRow key={row.services[0]?.service.name ?? row.title} target={target} title={row.title} entries={row.services} busyKey={busyKey} onAction={onAction} />
          ) : (
            <ServiceRow key={row.service.name} target={target} service={row.service} busyKey={busyKey} onAction={onAction} />
          )
        )}
      </ul>
    ) : null}
  </li>
);

/** group：目前頁籤的分組，只顯示屬於它的專案；onUngroupedCount：每次刷新後回報對不到任何分組的專案數，讓外層決定要不要顯示「其他」頁籤。 */
export const RunView = ({ group, onUngroupedCount }: { group: RunGroup; onUngroupedCount: (count: number) => void }) => {
  const [overview, setOverview] = useState<RunOverview | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const headProps = useProjectHead();
  const allTargets = overview?.targets ?? [];
  const targets = targetsOfRunGroup(allTargets, group.id);
  const hasTargets = targets.length > 0;

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

  useEffect(() => {
    if (overview !== null) onUngroupedCount(countUngroupedRunTargets(overview.targets));
  }, [overview, onUngroupedCount]);

  const act = async (target: RunTargetView, action: RunAction | readonly RunAction[]) => {
    const actions = "scope" in action ? [action] : action;
    const first = actions[0];
    if (first === undefined) return;
    setError("");
    setBusyKey(actionKey(target, first));
    try {
      // 多個動作依序執行（例如結束全部手機服務）；前一個失敗也繼續，最後把結果合併成一則訊息。
      const results: Array<{ ok: boolean; message: string }> = [];
      for (const item of actions) {
        results.push(await window.gitNRun.runProjectAction(target.id, item));
      }
      setMessage({ ok: results.every((result) => result.ok), text: `${target.label}：${results.map((result) => result.message).join("；")}` });
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
        <h1>{group.label}</h1>
        <p className="muted">
          {group.id === "other"
            ? "這些專案的資料夾名稱不在分組表裡，所以先放在這裡；選一個專案，按一下跑前後端。"
            : "選一個專案，按一下跑前後端；GitNRun 會從 package.json scripts 自動找出可啟動服務。"}
        </p>
      </div>
      <p className="muted">
        按下按鈕才會啟動；port 會在當下配置。用完按「結束」會停掉服務並關掉對應的 iTerm2 分頁，釋放電腦資源；結束手機服務時也會關掉 iOS 或 Android 模擬器。
        {overview && !overview.iterm ? <span className="warn"> 找不到 iTerm2，啟動類按鈕無法使用。</span> : null}
      </p>

      {overview && allTargets.length === 0 ? (
        <p className="empty muted">沒有可啟動的專案。專案只要在 Git / GitHub 頁籤設定本機路徑，就會自動出現在這裡。</p>
      ) : null}
      {overview && allTargets.length > 0 && !hasTargets ? (
        <p className="empty muted">
          這個分組目前沒有專案。專案資料夾名稱要和分組表一致才會出現在這裡：{group.folders.join("、") || "（無）"}。
        </p>
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
        {targets.map((target) => (
          <TargetRow
            key={target.id}
            target={target}
            busyKey={busyKey}
            headProps={headProps}
            onAction={(action) => void act(target, action)}
          />
        ))}
      </ul>
    </section>
  );
};
