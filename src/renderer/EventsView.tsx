import { useCallback, useEffect, useMemo, useState } from "react";
import type { EventQuery, PushEvent } from "@shared/events";
import type { Project } from "@shared/projects";
import {
  EVENT_TYPE_LABEL,
  FILE_STATUS_LABEL,
  TIME_RANGES,
  errorMessage,
  formatDateTime,
  formatRelative,
  rangeToFromMs,
  shortSha
} from "@shared/format";
import { EventAiActions } from "./AiAssist";
import { useDebounced, useMonitorChanged } from "./hooks";

const PAGE_SIZE = 50;

type ViewMode = "table" | "card";

const PusherText = ({ event }: { event: PushEvent }) => (
  <>
    {event.pusher ?? "—"}
    {event.pusher && event.pusherInferred ? <span className="muted">（推定）</span> : null}
  </>
);

const Badges = ({ event }: { event: PushEvent }) => (
  <>
    {event.eventType !== "push" ? <span className="badge">{EVENT_TYPE_LABEL[event.eventType]}</span> : null}
    {event.branchViolation ? <span className="badge warn-badge">分支名不合規</span> : null}
  </>
);

const EventDetail = ({ event, project }: { event: PushEvent; project: Project | undefined }) => (
  <aside className="detail">
    <h3>
      {project?.name ?? `專案 ${event.projectId}`} · {event.branch}
    </h3>
    <p className="muted">
      {formatDateTime(event.occurredAt)} · <PusherText event={event} /> · {EVENT_TYPE_LABEL[event.eventType]}
    </p>
    <p className="mono muted">
      {shortSha(event.beforeSha)} → {shortSha(event.afterSha)}
    </p>
    {event.branchViolation ? <p className="warn">這個分支名稱不符合命名規則。</p> : null}

    <h4>Commits（{event.commits.length}）</h4>
    {event.commits.length === 0 ? (
      <p className="muted">沒有可顯示的 commit。</p>
    ) : (
      <ul className="plain-list">
        {[...event.commits].reverse().map((commit) => (
          <li key={commit.sha}>
            <span className="mono">{shortSha(commit.sha)}</span> {commit.message.split("\n", 1)[0]}
            <span className="muted"> — {commit.author}</span>
          </li>
        ))}
      </ul>
    )}

    <EventAiActions key={event.id} eventId={event.id} />

    <h4>變更檔案（{event.fileCount}）</h4>
    {event.files.length === 0 ? (
      <p className="muted">沒有檔案變更資料。</p>
    ) : (
      <ul className="plain-list">
        {event.files.map((file) => (
          <li key={`${file.status}:${file.path}`}>
            <span className={`file-status file-${file.status}`}>{FILE_STATUS_LABEL[file.status]}</span>{" "}
            <span className="mono">{file.path}</span>
            {file.previousPath ? <span className="muted"> ← {file.previousPath}</span> : null}
          </li>
        ))}
      </ul>
    )}
  </aside>
);

export const EventsView = () => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number | "">("");
  const [branch, setBranch] = useState("");
  const [search, setSearch] = useState("");
  const [rangeId, setRangeId] = useState("7d");
  const [violationOnly, setViolationOnly] = useState(false);
  const [mode, setMode] = useState<ViewMode>("table");

  const [events, setEvents] = useState<PushEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const debouncedSearch = useDebounced(search.trim(), 250);
  const debouncedBranch = useDebounced(branch.trim(), 250);

  const baseQuery = useMemo((): EventQuery => {
    const query: EventQuery = {};
    if (projectId !== "") query.projectId = projectId;
    if (debouncedBranch) query.branch = debouncedBranch;
    if (debouncedSearch) query.search = debouncedSearch;
    if (violationOnly) query.branchViolationOnly = true;
    return query;
  }, [projectId, debouncedBranch, debouncedSearch, violationOnly]);

  const load = useCallback(
    async (append: boolean, currentCount: number) => {
      setLoading(true);
      setError("");
      try {
        // 時間範圍在每次載入時才換算成絕對時間，這樣「1 小時內」會隨時間移動。
        const fromMs = rangeToFromMs(rangeId);
        const page = await window.gitNRun.queryEvents({
          ...baseQuery,
          ...(fromMs === undefined ? {} : { fromMs }),
          limit: PAGE_SIZE,
          offset: append ? currentCount : 0
        });
        setEvents((previous) => (append ? [...previous, ...page.events] : page.events));
        setHasMore(page.hasMore);
      } catch (loadError) {
        setError(errorMessage(loadError));
      } finally {
        setLoading(false);
      }
    },
    [baseQuery, rangeId]
  );

  useEffect(() => {
    void window.gitNRun.listProjects().then(setProjects);
  }, []);

  useEffect(() => {
    void load(false, 0);
  }, [load]);

  useMonitorChanged((change) => {
    if (change.events) {
      void load(false, 0);
    }
  });

  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const knownBranches = useMemo(() => [...new Set(events.map((event) => event.branch))].sort(), [events]);
  const selected = events.find((event) => event.id === selectedId) ?? null;

  return (
    <section className="events-layout">
      <div className="events-main">
        <div className="filters">
          <select
            aria-label="專案"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value === "" ? "" : Number(event.target.value))}
          >
            <option value="">全部專案</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <input
            aria-label="分支"
            list="known-branches"
            placeholder="分支（完整名稱）"
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
          />
          <datalist id="known-branches">
            {knownBranches.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          <select aria-label="時間範圍" value={rangeId} onChange={(event) => setRangeId(event.target.value)}>
            {TIME_RANGES.map((range) => (
              <option key={range.id} value={range.id}>
                {range.label}
              </option>
            ))}
          </select>
          <input
            aria-label="搜尋"
            placeholder="搜尋訊息、分支、推送者、SHA"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <label className="inline-check">
            <input type="checkbox" checked={violationOnly} onChange={(event) => setViolationOnly(event.target.checked)} />
            只看分支名不合規
          </label>
          <div className="segmented" role="group" aria-label="檢視方式">
            <button type="button" className={mode === "table" ? "active" : ""} onClick={() => setMode("table")}>
              表格
            </button>
            <button type="button" className={mode === "card" ? "active" : ""} onClick={() => setMode("card")}>
              卡片
            </button>
          </div>
        </div>

        {error ? <p className="warn">{error}</p> : null}
        {events.length === 0 && !loading ? (
          <p className="muted empty">
            {projects.length === 0 ? "還沒有監視任何 repo，先到「專案」新增一個。" : "這個條件下沒有推送事件。"}
          </p>
        ) : null}

        {mode === "table" ? (
          <table className="events-table">
            <thead>
              <tr>
                <th>時間</th>
                <th>專案</th>
                <th>分支</th>
                <th>推送者</th>
                <th>訊息</th>
                <th>檔案</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr
                  key={event.id}
                  className={event.id === selectedId ? "selected" : ""}
                  onClick={() => setSelectedId(event.id)}
                >
                  <td title={formatDateTime(event.occurredAt)}>{formatRelative(event.occurredAt)}</td>
                  <td>{projectById.get(event.projectId)?.name ?? event.projectId}</td>
                  <td>
                    <span className="mono">{event.branch}</span> <Badges event={event} />
                  </td>
                  <td>
                    <PusherText event={event} />
                  </td>
                  <td>{event.headMessage || <span className="muted">—</span>}</td>
                  <td>{event.fileCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="cards">
            {events.map((event) => (
              <button
                key={event.id}
                type="button"
                className={`card ${event.id === selectedId ? "selected" : ""}`}
                onClick={() => setSelectedId(event.id)}
              >
                <div className="card-head">
                  <strong>{projectById.get(event.projectId)?.name ?? event.projectId}</strong>
                  <span className="muted">{formatRelative(event.occurredAt)}</span>
                </div>
                <div>
                  <span className="mono">{event.branch}</span> <Badges event={event} />
                </div>
                <div>{event.headMessage || <span className="muted">—</span>}</div>
                <div className="muted">
                  <PusherText event={event} /> · {event.fileCount} 個檔案
                </div>
              </button>
            ))}
          </div>
        )}

        {hasMore ? (
          <button type="button" disabled={loading} onClick={() => void load(true, events.length)}>
            載入更多
          </button>
        ) : null}
      </div>

      {selected ? <EventDetail event={selected} project={projectById.get(selected.projectId)} /> : null}
    </section>
  );
};
