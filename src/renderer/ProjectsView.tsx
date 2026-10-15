import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { MonitorStatus, ProjectPollStatus } from "@shared/monitor";
import {
  DEFAULT_POLL_INTERVAL_SEC,
  MAX_POLL_INTERVAL_SEC,
  MIN_POLL_INTERVAL_SEC,
  type Project,
  type ProjectMode
} from "@shared/projects";
import { errorMessage, formatDateTime, formatRelative } from "@shared/format";
import { useMonitorChanged, useProjectHead, type ProjectHeadAttrs } from "./hooks";
import { CommitMessagePanel, ConflictPanel } from "./AiAssist";
import { StartWorkPanel } from "./StartWorkPanel";

interface Props {
  onOpenSettings: () => void;
}

const splitFilter = (text: string): string[] => {
  const parts = text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts : ["*"];
};

const AddProjectForm = ({ onAdded }: { onAdded: () => void }) => {
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [interval, setIntervalSec] = useState(DEFAULT_POLL_INTERVAL_SEC);
  const [filter, setFilter] = useState("*");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await window.gitNRun.addProject({
        owner: owner.trim(),
        repo: repo.trim(),
        localPath: localPath.trim() === "" ? null : localPath.trim(),
        pollIntervalSec: interval,
        branchFilter: splitFilter(filter)
      });
      setOwner("");
      setRepo("");
      setLocalPath("");
      onAdded();
    } catch (addError) {
      setError(errorMessage(addError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="project-form" onSubmit={(event) => void submit(event)}>
      <h3>新增監視的 repo</h3>
      <div className="form-grid">
        <label>
          擁有者
          <input value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="例如 acme" required />
        </label>
        <label>
          Repo
          <input value={repo} onChange={(event) => setRepo(event.target.value)} placeholder="例如 widgets" required />
        </label>
        <label>
          本機路徑（選填）
          <input
            value={localPath}
            onChange={(event) => setLocalPath(event.target.value)}
            placeholder="/Users/me/widgets"
          />
        </label>
        <label>
          輪詢間隔（秒）
          <input
            type="number"
            min={MIN_POLL_INTERVAL_SEC}
            max={MAX_POLL_INTERVAL_SEC}
            value={interval}
            onChange={(event) => setIntervalSec(Number(event.target.value))}
          />
        </label>
        <label className="wide">
          監看的分支（逗號分隔，支援 * ?）
          <input value={filter} onChange={(event) => setFilter(event.target.value)} />
        </label>
      </div>
      {error ? <p className="warn">{error}</p> : null}
      <button type="submit" disabled={busy || owner.trim() === "" || repo.trim() === ""}>
        新增
      </button>
    </form>
  );
};

const ProjectRow = ({
  project,
  status,
  headProps,
  onChanged
}: {
  project: Project;
  status: ProjectPollStatus | undefined;
  headProps: (path: string | null) => ProjectHeadAttrs;
  onChanged: () => void;
}) => {
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [startingWork, setStartingWork] = useState(false);
  const [aiPanel, setAiPanel] = useState<"commit" | "conflict" | null>(null);
  const [error, setError] = useState("");

  const run = async (action: () => Promise<unknown>) => {
    setError("");
    try {
      await action();
      onChanged();
    } catch (actionError) {
      setError(errorMessage(actionError));
    }
  };

  return (
    <li className="project-row">
      <div {...headProps(project.localPath)}>
        <strong>{project.name}</strong>
        <span className="muted mono">
          {project.owner}/{project.repo}
        </span>
      </div>
      <div className="muted">
        {project.mode === "webhook" ? "只接收 Webhook" : `每 ${project.pollIntervalSec} 秒`} · 分支：{project.branchFilter.join(", ")}
        {project.localPath ? ` · ${project.localPath}` : ""}
      </div>
      <div>
        {status?.lastError ? (
          <span className="warn">{status.lastError}</span>
        ) : status?.lastPolledAt ? (
          <span className="muted" title={formatDateTime(status.lastPolledAt)}>
            上次檢查 {formatRelative(status.lastPolledAt)}
          </span>
        ) : (
          <span className="muted">尚未檢查</span>
        )}
      </div>
      <div className="row-actions">
        <label className="inline-check">
          <input
            type="checkbox"
            checked={project.enabled}
            onChange={(event) => void run(() => window.gitNRun.updateProject(project.id, { enabled: event.target.checked }))}
          />
          啟用
        </label>
        <select
          aria-label="監視模式"
          title="輪詢：定時檢查（預設）；Webhook：GitHub 主動通知（需要先在設定開啟 Webhook）"
          value={project.mode}
          onChange={(event) => void run(() => window.gitNRun.updateProject(project.id, { mode: event.target.value as ProjectMode }))}
        >
          <option value="poll">輪詢</option>
          <option value="webhook">Webhook</option>
          <option value="both">輪詢＋Webhook</option>
        </select>
        <label className="inline-check" title="允許把這個專案的差異、commit 訊息送給 AI 分析（排除清單與密鑰遮蔽仍然生效）">
          <input
            type="checkbox"
            checked={project.aiEnabled}
            onChange={(event) => void run(() => window.gitNRun.updateProject(project.id, { aiEnabled: event.target.checked }))}
          />
          允許 AI 分析
        </label>
        <button
          type="button"
          disabled={!project.enabled || status?.inFlight}
          onClick={() => void run(() => window.gitNRun.pollProjectNow(project.id))}
        >
          立即檢查
        </button>
        <button
          type="button"
          disabled={!project.localPath}
          title={project.localPath ? "依分支命名規則建立並推送新分支" : "需要先設定本機路徑"}
          onClick={() => setStartingWork((open) => !open)}
        >
          開工
        </button>
        <button
          type="button"
          disabled={!project.localPath}
          title={project.localPath ? "根據尚未提交的變更產生 commit 訊息" : "需要先設定本機路徑"}
          onClick={() => setAiPanel(aiPanel === "commit" ? null : "commit")}
        >
          commit 訊息
        </button>
        <button
          type="button"
          disabled={!project.localPath}
          title={project.localPath ? "預測目前分支與遠端分支合併是否衝突" : "需要先設定本機路徑"}
          onClick={() => setAiPanel(aiPanel === "conflict" ? null : "conflict")}
        >
          預測衝突
        </button>
        {confirmingRemove ? (
          <>
            <button type="button" className="danger" onClick={() => void run(() => window.gitNRun.removeProject(project.id))}>
              確定刪除（連同事件記錄）
            </button>
            <button type="button" onClick={() => setConfirmingRemove(false)}>
              取消
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setConfirmingRemove(true)}>
            刪除
          </button>
        )}
      </div>
      {error ? <p className="warn">{error}</p> : null}
      {startingWork ? <StartWorkPanel project={project} onClose={() => setStartingWork(false)} /> : null}
      {aiPanel === "commit" ? <CommitMessagePanel project={project} onClose={() => setAiPanel(null)} /> : null}
      {aiPanel === "conflict" ? <ConflictPanel project={project} onClose={() => setAiPanel(null)} /> : null}
    </li>
  );
};

export const ProjectsView = ({ onOpenSettings }: Props) => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [status, setStatus] = useState<MonitorStatus | null>(null);
  const [hasToken, setHasToken] = useState(true);

  const refresh = useCallback(() => {
    void window.gitNRun.listProjects().then(setProjects);
    void window.gitNRun.getMonitorStatus().then(setStatus);
    void window.gitNRun.getSecretsOverview().then((overview) => {
      setHasToken(overview.secrets.some((secret) => secret.name === "github.pat" && secret.configured));
    });
  }, []);

  useEffect(refresh, [refresh]);
  useMonitorChanged(refresh);
  const headProps = useProjectHead();

  const statusByProject = new Map(status?.projects.map((entry) => [entry.projectId, entry]));

  return (
    <section>
      {hasToken ? null : (
        <p className="notice">
          還沒有設定 GitHub Token，無法檢查 repo。
          <button type="button" onClick={onOpenSettings}>
            前往設定
          </button>
        </p>
      )}
      <AddProjectForm onAdded={refresh} />
      <h3>監視中的專案</h3>
      {projects.length === 0 ? <p className="muted">還沒有專案。</p> : null}
      <ul className="project-list">
        {projects.map((project) => (
          <ProjectRow key={project.id} project={project} status={statusByProject.get(project.id)} headProps={headProps} onChanged={refresh} />
        ))}
      </ul>
    </section>
  );
};
