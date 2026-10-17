import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { errorMessage } from "@shared/format";
import { useProjectHead, type ProjectHeadAttrs } from "./hooks";
import {
  MOBILE_PLATFORM_LABEL,
  RUN_STATE_LABEL,
  displayServiceName,
  groupRunServices,
  mobilePlatformOf,
  passcodeProblem,
  passcodeStateText,
  planMobileStop,
  summarizeMobileState,
  type MobilePlatform,
  type PasscodeBinding,
  type RunAction,
  type RunButtonState,
  type RunOverview,
  type RunServiceState,
  type RunServiceView,
  type RunTargetView
} from "@shared/run";
import { countUngroupedRunTargets, type RunGroup } from "@shared/run-groups";
import {
  EMPTY_RUN_ORDER,
  buildRunOrderEntries,
  commitRunOrder,
  entriesOfTargets,
  orderedRunServiceRows,
  orderedRunTargets,
  runSortModeOf,
  sortByOpenIssues,
  type RunOrder
} from "@shared/run-order";
import { formatGroupIssueTotal, isIssueSkippedGroup, summarizeIssueGroup } from "@shared/git-lite";
import { ChangeBadge } from "./ChangeBadge";
import { IssueSection, useIssueDisplayPref, useIssueFeed } from "./IssueSection";
import { RunOrderEditor, RunSortSwitch, useRunOrderPref, useRunSortModePref } from "./RunOrderEditor";

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
    // 渲染層的瀏覽器剪貼簿權限被 session lockdown 一律拒絕，改走主程序的 IPC 寫入剪貼簿。
    void window.gitNRun.copyText(command).then(
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

/**
 * 專案路徑不直接攤在卡片上，點一下複製即可；結果用按鈕文字短暫提示，不展開浮層。
 * missing 為真時路徑在磁碟上已找不到（上次新增／編輯時檢查的結果），但仍允許複製——
 * 可能就是要複製這個路徑去手動重建資料夾。
 */
const PathCopyButton = ({ path, missing }: { path: string; missing?: boolean }) => {
  const [copy, setCopy] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timer.current), []);

  const flash = (next: CopyState): void => {
    setCopy(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopy("idle"), COPY_FLASH_MS);
  };

  const onClick = (): void => {
    // 渲染層的瀏覽器剪貼簿權限被 session lockdown 一律拒絕，改走主程序的 IPC 寫入剪貼簿。
    void window.gitNRun.copyText(path).then(
      () => flash("copied"),
      () => flash("failed")
    );
  };

  return (
    <>
      <button type="button" className="ghost" onClick={onClick}>
        {copy === "copied" ? "已複製" : copy === "failed" ? "複製失敗" : "複製路徑"}
      </button>
      {missing ? <span className="warn-badge" title="此路徑目前在磁碟上找不到">路徑不存在</span> : null}
    </>
  );
};

/** Debug 密碼的來源與設定：密碼只留在專案的環境檔，GitNRun 只讀取；這裡只管「讀哪個檔的哪個鍵」。 */
const DebugPasswordActions = ({
  target,
  onChanged,
  onMessage
}: {
  target: RunTargetView;
  onChanged: () => void;
  onMessage: (ok: boolean, text: string) => void;
}) => {
  const source = target.passcodeSource;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [file, setFile] = useState("");
  const [key, setKey] = useState("");
  const canCopy = source.state === "ok";
  const canOpenFile = source.state !== "unbound" && source.state !== "no-file" && source.state !== "unsafe";

  /** 各動作共用：忙碌旗標、錯誤顯示，完成後刷新總覽。 */
  const perform = async (work: () => Promise<void>, done?: string): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      await work();
      onChanged();
      if (done !== undefined) onMessage(true, `${target.label}：${done}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (): Promise<void> => {
    setBusy(true);
    try {
      await window.gitNRun.copyRunPasscode(target.id);
      onMessage(true, `${target.label}：已複製 Debug 密碼，剪貼簿會在 60 秒後清除`);
    } catch (cause) {
      onMessage(false, `${target.label}：${errorMessage(cause)}`);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const bind = (binding: PasscodeBinding): Promise<void> =>
    perform(async () => {
      await window.gitNRun.bindRunPasscode(target.id, binding);
      setFile("");
      setKey("");
    }, `已指定 Debug 密碼來源：${binding.file} 的 ${binding.key}`);

  /** 取消設定成功才收起面板；失敗時維持展開，錯誤訊息才看得到。 */
  const unbind = (): Promise<void> =>
    perform(async () => {
      await window.gitNRun.unbindRunPasscode(target.id);
      setOpen(false);
    }, "已取消設定 Debug 密碼");

  return (
    <div className="run-password-actions">
      <button type="button" disabled={!canCopy || busy} title={canCopy ? undefined : passcodeProblem(source.state, source.binding)} onClick={() => void copy()}>
        複製 Debug 密碼
      </button>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        設定密碼
      </button>
      {open ? (
        <div className="run-password-panel">
          <p className="run-password-status">
            {source.binding === null ? (
              "尚未指定密碼來源"
            ) : (
              <>
                專案環境檔 · <span className="mono">{source.binding.file}</span> · <span className="mono">{source.binding.key}</span> ·{" "}
                {source.state === "ok" ? `已讀到${source.hint === "" ? "" : `，末四碼 ${source.hint}`}` : <span className="warn">{passcodeStateText(source.state)}</span>}
              </>
            )}
          </p>
          {source.binding !== null ? (
            <div className="run-password-row">
              <button
                type="button"
                disabled={busy || !canOpenFile}
                title={canOpenFile ? undefined : passcodeStateText(source.state)}
                onClick={() => void perform(() => window.gitNRun.openRunPasscodeFile(target.id))}
              >
                開啟環境檔
              </button>
              <button type="button" disabled={busy} onClick={() => onChanged()}>
                重新檢查
              </button>
              <button type="button" disabled={busy} onClick={() => void unbind()}>
                取消設定密碼
              </button>
              <span className="muted">要改密碼，請直接編輯這個環境檔；每次複製都會重新讀取。</span>
            </div>
          ) : (
            <>
              {source.candidates.length > 0 ? (
                <div className="run-password-row">
                  <span className="muted">偵測到：</span>
                  {source.candidates.map((candidate) => (
                    <button key={`${candidate.file}:${candidate.key}`} type="button" disabled={busy} onClick={() => void bind(candidate)}>
                      使用 {candidate.file} 的 {candidate.key}
                    </button>
                  ))}
                </div>
              ) : null}
              <form
                className="run-password-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void bind({ file: file.trim(), key: key.trim() });
                }}
              >
                <input value={file} placeholder="環境檔，例如 .env" aria-label={`${target.label} 環境檔路徑`} autoComplete="off" spellCheck={false} onChange={(event) => setFile(event.target.value)} />
                <input value={key} placeholder="鍵名，例如 DEBUG_PASSWORD" aria-label={`${target.label} 密碼鍵名`} autoComplete="off" spellCheck={false} onChange={(event) => setKey(event.target.value)} />
                <button type="submit" disabled={busy || file.trim() === "" || key.trim() === ""}>
                  指定環境檔
                </button>
              </form>
            </>
          )}
          {error ? (
            <span className="warn" role="alert">
              {error}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
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
        {!service.url && service.fixedPort !== null ? <span className="mono muted">固定 http://localhost:{service.fixedPort}</span> : null}
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
  onAction,
  onPasswordChanged,
  onPasswordMessage,
  order,
  changes,
  issues
}: {
  target: RunTargetView;
  busyKey: string;
  headProps: (path: string) => ProjectHeadAttrs;
  onAction: (action: RunAction | readonly RunAction[]) => void;
  onPasswordChanged: () => void;
  onPasswordMessage: (ok: boolean, text: string) => void;
  /** 你固定下來的手動排序；服務列依它排列。 */
  order: RunOrder;
  /** 標題下方的變更檔案數；讀不到時不畫。 */
  changes: ReactNode;
  /** 服務列表下方的 GitHub issues 區塊；關閉顯示時為 null。 */
  issues: ReactNode;
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
        <DebugPasswordActions target={target} onChanged={onPasswordChanged} onMessage={onPasswordMessage} />
        {target.buttons.stop.enabled ? (
          <ActionButton
            label="結束全部"
            state={target.buttons.stop}
            busy={busyKey !== "" && busyKey !== actionKey(target, { scope: "project", action: "stop" })}
            onClick={() => onAction({ scope: "project", action: "stop" })}
          />
        ) : null}
        <ActionButton
          label="重裝依賴"
          state={target.reinstall}
          busy={busyKey !== "" && busyKey !== actionKey(target, { scope: "project", action: "reinstall" })}
          onClick={() => onAction({ scope: "project", action: "reinstall" })}
        />
      </div>
      {changes}
      <PathCopyButton path={target.folder} missing={target.source === "project" && target.pathExists === false} />
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
        {orderedRunServiceRows(target.folder, groupRunServices(target.services), order).map((row) =>
          row.kind === "mobile" ? (
            <MobileRow key={row.services[0]?.service.name ?? row.title} target={target} title={row.title} entries={row.services} busyKey={busyKey} onAction={onAction} />
          ) : (
            <ServiceRow key={row.service.name} target={target} service={row.service} busyKey={busyKey} onAction={onAction} />
          )
        )}
      </ul>
    ) : null}
    {issues}
  </li>
);

/** group：目前頁籤的分組，只顯示屬於它的專案；onUngroupedCount：每次刷新後回報對不到任何分組的專案數，讓外層決定要不要顯示「其他」頁籤。 */
export const RunView = ({
  group,
  onUngroupedCount,
  onOpenSettings
}: {
  group: RunGroup;
  onUngroupedCount: (count: number) => void;
  onOpenSettings: () => void;
}) => {
  const [overview, setOverview] = useState<RunOverview | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const headProps = useProjectHead();
  const allTargets = overview?.targets ?? [];
  const [savedOrder, saveOrder] = useRunOrderPref();
  const [sortModes, saveSortMode] = useRunSortModePref();
  const [reordering, setReordering] = useState(false);
  // 開源、自己用等分組不需要 issue：整個功能（區塊、摘要、開關、排序、GitHub 請求）都不啟用。
  const issuesAllowed = !isIssueSkippedGroup(group.id);
  const sortMode = issuesAllowed ? runSortModeOf(sortModes, group.id) : "manual";
  const [issuePref, setIssuePref] = useIssueDisplayPref();
  const showIssues = issuesAllowed && issuePref;
  // 依 issue 數量排序也要有 issue 資料，所以就算不顯示 issue 區塊也要讀。
  const { feed: issueFeed, gitFeed, refresh: refreshIssues } = useIssueFeed(showIssues || sortMode === "issues");
  // issue 數量排序疊在手動順序上：同數量沿用手動順序，資料還沒到位時就是手動順序。
  const manualTargets = orderedRunTargets(allTargets, group.id, savedOrder);
  const targets = sortMode === "issues" ? sortByOpenIssues(manualTargets, issueFeed) : manualTargets;
  const sortNote =
    sortMode !== "issues"
      ? null
      : issueFeed.status === "loading"
        ? "讀取 issue 數量中，先依手動順序"
        : issueFeed.status === "failed"
          ? "讀不到 issue 數量，先依手動順序"
          : null;
  const hasTargets = targets.length > 0;
  const canReorder = targets.length > 1 || targets.some((target) => groupRunServices(target.services).length > 1);
  const defaultOrderEntries = reordering ? buildRunOrderEntries(allTargets, group.id, EMPTY_RUN_ORDER) : [];
  const issueSummary = summarizeIssueGroup(issueFeed, targets.map((target) => target.folder));

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
      {(hasTargets && showIssues) || group.id === "other" ? (
        <div className="run-hero">
          {hasTargets && showIssues ? (
            <div className="run-chips">
              <span className="badge">{targets.length} 個專案</span>
              {issueSummary.openIssues ? <span className="badge issue-chip">{formatGroupIssueTotal(issueSummary.openIssues)}</span> : null}
            </div>
          ) : null}
          {group.id === "other" ? <p className="muted">這些專案的資料夾名稱不在分組表裡，所以先放在這裡。</p> : null}
        </div>
      ) : null}
      {overview && !overview.iterm ? <p className="warn">找不到 iTerm2，啟動類按鈕無法使用。</p> : null}

      {overview && allTargets.length === 0 ? (
        <p className="empty muted">沒有可啟動的專案。把專案資料夾放進個人專案根目錄後，就會自動出現在這裡。</p>
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
          <div className="run-list-tools">
            {issuesAllowed && !reordering ? <RunSortSwitch mode={sortMode} onChange={(mode) => saveSortMode(group.id, mode)} note={sortNote} /> : null}
            {canReorder && !reordering ? (
              <button type="button" className="ghost" onClick={() => setReordering(true)}>
                調整順序
              </button>
            ) : null}
            {issuesAllowed ? (
              <label className="inline-check">
                <input type="checkbox" checked={issuePref} onChange={(event) => setIssuePref(event.target.checked)} />
                在專案下方顯示 GitHub issues
              </label>
            ) : null}
          </div>
        </div>
      ) : null}
      {reordering ? (
        <RunOrderEditor
          initial={entriesOfTargets(targets, savedOrder)}
          defaults={defaultOrderEntries}
          projectsLocked={sortMode === "issues"}
          onSave={(draft) => {
            saveOrder(commitRunOrder(savedOrder, group.id, draft, defaultOrderEntries, { projects: sortMode !== "issues" }));
            setReordering(false);
          }}
          onCancel={() => setReordering(false)}
        />
      ) : null}
      {/* 調整順序時只藏起來、不卸載，讓密碼表單與 issues 區塊的狀態不會被洗掉。 */}
      <ul className="project-list" hidden={reordering}>
        {targets.map((target) => (
          <TargetRow
            key={target.id}
            target={target}
            busyKey={busyKey}
            headProps={headProps}
            onAction={(action) => void act(target, action)}
            onPasswordChanged={refresh}
            onPasswordMessage={(ok, text) => {
              setError("");
              setMessage({ ok, text });
            }}
            order={savedOrder}
            changes={<ChangeBadge feed={gitFeed} folder={target.folder} />}
            issues={
              showIssues ? (
                <IssueSection feed={issueFeed} folder={target.folder} label={target.label} onRetry={refreshIssues} onOpenSettings={onOpenSettings} />
              ) : null
            }
          />
        ))}
      </ul>
    </section>
  );
};
