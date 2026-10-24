import { useEffect, useRef, useState, type ReactNode } from "react";
import { errorMessage } from "@shared/format";
import { useProjectHead, type ProjectHeadAttrs } from "./hooks";
import { DebugAccountActions } from "./DebugAccountActions";
import { DebugPasswordActions } from "./DebugPasswordActions";
import {
  MOBILE_PLATFORM_LABEL,
  RUN_STATE_LABEL,
  backendGroupButtons,
  displayServiceName,
  groupButtonState,
  groupRunServices,
  mobilePlatformOf,
  mobileDeviceLabel,
  summarizeBackendState,
  summarizeMobileState,
  type MobilePlatform,
  type RunAction,
  type RunButtonState,
  type RunServiceState,
  type RunServiceView,
  type RunTargetView
} from "@shared/run";
import { countUngroupedRunTargets, type RunGroup } from "@shared/run-groups";
import { serviceHintOf } from "@shared/run-hints";
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
import { isIssueSkippedGroup } from "@shared/git-lite";
import { ChangeBadge } from "./ChangeBadge";
import { IssueSection, useIssueDisplayPref } from "./IssueSection";
import { useRunData } from "./RunDataContext";
import { RunOrderEditor, RunSortSwitch, useRunOrderPref, useRunSortModePref } from "./RunOrderEditor";

const COPY_FLASH_MS = 1_500;

const ROLE_LABEL = { backend: "後端", frontend: "前端", desktop: "桌面" } as const;
const STATE_LABEL = RUN_STATE_LABEL;
const PLATFORM_LABEL = MOBILE_PLATFORM_LABEL;

/** 標籤優先顯示偵測到的框架，辨識不出來才退回角色。 */
const serviceBadgeLabel = (service: RunServiceView): string =>
  service.framework ?? (mobilePlatformOf(service.name) !== null ? "手機" : ROLE_LABEL[service.role]);

/** 服務標題的平台色：名稱含 mobile 片段（或是 iOS／Android）為橘色，含 web 片段為紫色，其餘維持預設黑色。 */
const platformTone = (name: string): string => {
  const segments = name.toLowerCase().split("-");
  if (mobilePlatformOf(name) !== null || segments.includes("mobile")) return " platform-mobile";
  if (segments.includes("web")) return " platform-web";
  return "";
};

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

/** 多台裝置的指令收進一個選單：點「指令」展開，點某台就複製它的指令；點外面或按 Esc 關閉。 */
const CommandMenu = ({ items }: { items: ReadonlyArray<{ key: string; label: string; command: string }> }) => {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState("");
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

  const copy = (item: { key: string; command: string }): void => {
    // 渲染層的瀏覽器剪貼簿權限被 session lockdown 一律拒絕，改走主程序的 IPC 寫入剪貼簿。
    void window.gitNRun.copyText(item.command).then(
      () => setCopied(item.key),
      () => setCopied("")
    );
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(""), COPY_FLASH_MS);
  };

  return (
    <span className="run-command-wrap" ref={ref}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        指令 ▾
      </button>
      {open ? (
        <span className="run-command-pop run-command-menu">
          {items.map((item) => (
            <button type="button" key={item.key} title={item.command} onClick={() => copy(item)}>
              {copied === item.key ? "已複製" : `複製 ${item.label} 指令`}
            </button>
          ))}
        </span>
      ) : null}
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
  const webAction: RunAction = { scope: "service", service: service.name, action: "web" };
  const releaseAction: RunAction = { scope: "service", service: service.name, action: "release" };
  const busy = (action: RunAction): boolean => busyKey !== "" && busyKey !== actionKey(target, action);

  return (
    <li className="run-service">
      <div className="run-service-main">
        <span className={`status-dot ${service.state}`} title={STATE_LABEL[service.state]} />
        <span className={`run-service-title${platformTone(service.name)}`} title={serviceHintOf(target.folder, service.name)}>{displayServiceName(service.name)}</span>
        <span className="badge run-framework">{serviceBadgeLabel(service)}</span>
        <span className="muted">{STATE_LABEL[service.state]}</span>
        {service.exitedEarly ? (
          <span className="warn" title="啟動後程序立即結束，可能已有舊的實例在背景執行，或啟動指令出錯；請看 iTerm2 分頁的輸出，或按「結束」清掉殘留後再啟動。">
            啟動後立即退出
          </span>
        ) : null}
        {service.url ? <span className="mono">{service.url}</span> : null}
        {!service.url && service.fixedPort !== null ? <span className="mono muted">固定 http://localhost:{service.fixedPort}</span> : null}
      </div>
      <div className="row-actions run-service-actions">
        <ActionButton label={startLabel(service)} state={service.buttons.start} busy={busy(startAction)} onClick={() => onAction(startAction)} />
        {service.role === "frontend" ? <ActionButton label="開網頁" state={service.buttons.web} busy={busy(webAction)} onClick={() => onAction(webAction)} /> : null}
        <ActionButton label="釋放 port" state={service.buttons.release} busy={busy(releaseAction)} onClick={() => onAction(releaseAction)} />
        <CommandButton command={service.command} />
      </div>
    </li>
  );
};

/** 同一個 App 的 iOS、Android 手機服務合併成一列，標題是去掉平台後的 App 名稱：啟動各平台分開，釋放 port 共用一顆，一次釋放底下所有可釋放的裝置。 */
const MobileRow = ({
  target,
  title,
  entries,
  busyKey,
  onAction
}: {
  target: RunTargetView;
  title: string;
  entries: Array<{ platform: MobilePlatform; variant: string; service: RunServiceView }>;
  busyKey: string;
  onAction: (action: RunAction | readonly RunAction[]) => void;
}) => {
  const busy = (action: RunAction): boolean => busyKey !== "" && busyKey !== actionKey(target, action);
  const releaseActions: RunAction[] = entries
    .filter(({ service }) => service.buttons.release.enabled)
    .map(({ service }) => ({ scope: "service", service: service.name, action: "release" }));
  const summary = summarizeMobileState(entries.map(({ platform, variant, service }) => ({ platform, variant, state: service.state })));
  const first = entries[0]?.service;

  // 同一個 App 有第二台 iOS（ios2）時，每台裝置各佔一行；只有一台 iOS 與一台 Android 時維持單排。
  if (entries.some((entry) => entry.variant !== "")) {
    return (
      <li className="run-service">
        <div className="run-service-main">
          <span className={`status-dot ${summary.state}`} title={summary.text} />
          <span className="run-service-title platform-mobile" title={serviceHintOf(target.folder, title)}>{displayServiceName(title)}</span>
          <span className="badge run-framework">{first === undefined ? "手機" : serviceBadgeLabel(first)}</span>
          <span className="muted">{summary.text}</span>
        </div>
        <div className="row-actions run-service-actions">
          {releaseActions[0] !== undefined ? (
            <ActionButton label="釋放 port" state={groupButtonState(entries.map((entry) => entry.service), "release")} busy={busy(releaseActions[0])} onClick={() => onAction(releaseActions)} />
          ) : null}
          <CommandMenu items={entries.map(({ platform, variant, service }) => ({ key: service.name, label: mobileDeviceLabel(platform, variant), command: service.command }))} />
        </div>
        <div className="run-devices">
          {entries.map(({ platform, variant, service }) => {
            const name = mobileDeviceLabel(platform, variant);
            const startAction: RunAction = { scope: "service", service: service.name, action: "start" };
            return (
              <button
                type="button"
                className="run-device"
                key={service.name}
                disabled={!service.buttons.start.enabled || busy(startAction)}
                title={service.buttons.start.reason ?? `啟動 ${name}`}
                onClick={() => onAction(startAction)}
              >
                <span className={`status-dot ${service.state}`} />
                {name}
              </button>
            );
          })}
        </div>
      </li>
    );
  }

  return (
    <li className="run-service">
      <div className="run-service-main">
        <span className={`status-dot ${summary.state}`} title={summary.text} />
        <span className="run-service-title platform-mobile" title={serviceHintOf(target.folder, title)}>{displayServiceName(title)}</span>
        <span className="badge run-framework">{first === undefined ? "手機" : serviceBadgeLabel(first)}</span>
        <span className="muted">{summary.text}</span>
      </div>
      <div className="row-actions run-service-actions">
        {entries.map(({ platform, service }) => {
          const name = PLATFORM_LABEL[platform];
          const startAction: RunAction = { scope: "service", service: service.name, action: "start" };
          return (
            <span className="run-platform" key={service.name}>
              <ActionButton label={`啟動 ${name}`} state={service.buttons.start} busy={busy(startAction)} onClick={() => onAction(startAction)} />
            </span>
          );
        })}
        {releaseActions[0] !== undefined ? (
          <ActionButton label="釋放 port" state={groupButtonState(entries.map((entry) => entry.service), "release")} busy={busy(releaseActions[0])} onClick={() => onAction(releaseActions)} />
        ) : null}
        {entries.map(({ platform, service }) => (
          <CommandButton key={service.name} command={service.command} label={`${PLATFORM_LABEL[platform]} 指令`} />
        ))}
      </div>
    </li>
  );
};

/** 同專案的多個後端合併成一列：啟動、釋放 port 都是整組一次完成；組內每個後端只列名稱、狀態與 port。 */
const BackendRow = ({
  target,
  title,
  services,
  busyKey,
  onAction
}: {
  target: RunTargetView;
  title: string;
  services: RunServiceView[];
  busyKey: string;
  onAction: (action: RunAction | readonly RunAction[]) => void;
}) => {
  const busy = (action: RunAction): boolean => busyKey !== "" && busyKey !== actionKey(target, action);
  const startAction: RunAction = { scope: "project", action: "start-backend" };
  const releaseAction: RunAction = { scope: "project", action: "release-backend" };
  const buttons = backendGroupButtons(services);
  const summary = summarizeBackendState(services);

  return (
    <li className="run-service">
      <div className="run-service-main">
        <span className={`status-dot ${summary.state}`} title={summary.text} />
        <span className="run-service-title">{title}</span>
        <span className="badge run-framework">後端</span>
        <span className="muted">{summary.text}</span>
      </div>
      <div className="row-actions run-service-actions">
        <ActionButton label="啟動全部後端" state={buttons.start} busy={busy(startAction)} onClick={() => onAction(startAction)} />
        <ActionButton label="釋放全部後端 port" state={buttons.release} busy={busy(releaseAction)} onClick={() => onAction(releaseAction)} />
      </div>
      <ul className="plain-list run-backend-members">
        {services.map((service) => (
          <li key={service.name}>
            <span className={`status-dot ${service.state}`} title={STATE_LABEL[service.state]} />
            <span title={serviceHintOf(target.folder, service.name)}>{displayServiceName(service.name)}</span>
            <span className="badge">{serviceBadgeLabel(service)}</span>
            <span className="muted">{STATE_LABEL[service.state]}</span>
            {service.url ? <span className="mono">{service.url}</span> : null}
            {!service.url && service.fixedPort !== null ? <span className="mono muted">固定 http://localhost:{service.fixedPort}</span> : null}
            {service.exitedEarly ? <span className="warn">啟動後立即退出</span> : null}
            <CommandButton command={service.command} />
          </li>
        ))}
      </ul>
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
      <div className="run-project-line">
        <strong>{target.label}</strong>
        {target.manifest === "invalid" ? <span className="warn-badge">啟動設定有誤</span> : null}
        {changes}
      </div>
      <div className="run-project-title">
        <ActionButton
          label="README"
          state={target.readme}
          busy={busyKey !== "" && busyKey !== actionKey(target, { scope: "project", action: "readme" })}
          onClick={() => onAction({ scope: "project", action: "readme" })}
        />
        <DebugAccountActions target={target} onChanged={onPasswordChanged} onMessage={onPasswordMessage} />
        <DebugPasswordActions target={target} onChanged={onPasswordChanged} onMessage={onPasswordMessage} />
        <ActionButton
          label="釋放全部 port"
          state={groupButtonState(target.services, "release")}
          busy={busyKey !== "" && busyKey !== actionKey(target, { scope: "project", action: "release-all" })}
          onClick={() => onAction({ scope: "project", action: "release-all" })}
        />
        <ActionButton
          label="重裝依賴"
          state={target.reinstall}
          busy={busyKey !== "" && busyKey !== actionKey(target, { scope: "project", action: "reinstall" })}
          onClick={() => onAction({ scope: "project", action: "reinstall" })}
        />
        <PathCopyButton path={target.folder} missing={target.source === "project" && target.pathExists === false} />
      </div>
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
          row.kind === "backend" ? (
            <BackendRow key={row.title} target={target} title={row.title} services={row.services} busyKey={busyKey} onAction={onAction} />
          ) : row.kind === "mobile" ? (
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

/** group：目前頁籤的分組，只顯示屬於它的專案；資料來自 App 層共用的 RunDataProvider，切頁籤不重抓。 */
export const RunView = ({
  group,
  onOpenSettings
}: {
  group: RunGroup;
  onOpenSettings: () => void;
}) => {
  const { overview, overviewError, refreshOverview: refresh, feed: issueFeed, gitFeed, refreshFeed: refreshIssues, setWantsIssues } = useRunData();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const headProps = useProjectHead();
  const allTargets = overview?.targets ?? [];
  const [savedOrder, saveOrder] = useRunOrderPref();
  const [sortModes, saveSortMode] = useRunSortModePref();
  const [reordering, setReordering] = useState(false);
  // Free 分組（開源與自用專案）不需要 issue：整個功能（區塊、摘要、開關、排序、GitHub 請求）都不啟用。
  const issuesAllowed = !isIssueSkippedGroup(group.id);
  const sortMode = issuesAllowed ? runSortModeOf(sortModes, group.id) : "manual";
  const [issuePref, setIssuePref] = useIssueDisplayPref();
  const showIssues = issuesAllowed && issuePref;
  // 依 issue 數量排序也要有 issue 資料，所以就算不顯示 issue 區塊也要讀。
  const wantsIssues = showIssues || sortMode === "issues";
  useEffect(() => setWantsIssues(wantsIssues), [wantsIssues, setWantsIssues]);
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

  const act = async (target: RunTargetView, action: RunAction | readonly RunAction[]) => {
    const actions = "scope" in action ? [action] : action;
    const first = actions[0];
    if (first === undefined) return;
    setError("");
    setBusyKey(actionKey(target, first));
    try {
      // 多個動作依序執行（例如釋放該 App 底下所有手機服務）；前一個失敗也繼續，最後把結果合併成一則訊息。
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
      {group.id === "other" ? (
        <div className="run-hero">
          <p className="muted">這些專案的資料夾名稱不在分組表裡，所以先放在這裡。</p>
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
      {error || overviewError ? <p className="warn">{error || overviewError}</p> : null}

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
            changes={<ChangeBadge feed={gitFeed} folder={target.folder} label={target.label} />}
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
