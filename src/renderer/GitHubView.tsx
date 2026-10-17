import { useCallback, useEffect, useMemo, useState } from "react";
import { isIssueSkippedFolder, rankByChangedFiles, type GitLiteOverview, type GitLiteProject } from "@shared/git-lite";
import { errorMessage, formatRelative } from "@shared/format";
import { useProjectHead } from "./hooks";

const REFRESH_MS = 30_000;

const GitSummary = ({ project }: { project: GitLiteProject }) => {
  if (!project.isGitRepo) {
    return <span className="muted">{project.statusError ?? "不是 git repo"}</span>;
  }
  return (
    <div className="git-summary">
      <span className="badge">{project.branch ?? "detached"}</span>
      {project.upstream ? <span className="muted">upstream：{project.upstream}</span> : <span className="warn">沒有 upstream</span>}
      <span className={project.ahead > 0 ? "warn" : "muted"}>未 push：{project.ahead}</span>
      <span className={project.behind > 0 ? "warn" : "muted"}>落後：{project.behind}</span>
      <span className={project.changedFiles > 0 ? "warn" : "muted"}>變更檔案：{project.changedFiles}</span>
      {project.untrackedFiles > 0 ? <span className="muted">未追蹤：{project.untrackedFiles}</span> : null}
    </div>
  );
};

export const GitHubView = ({ onOpenSettings }: { onOpenSettings: () => void }) => {
  const [overview, setOverview] = useState<GitLiteOverview | null>(null);
  const [error, setError] = useState("");
  const headProps = useProjectHead();
  const ranked = useMemo(() => rankByChangedFiles(overview?.projects ?? []), [overview]);

  const refresh = useCallback(() => {
    void window.gitNRun
      .getGitLiteOverview()
      .then((result) => {
        setOverview(result);
        setError("");
      })
      .catch((refreshError) => setError(errorMessage(refreshError)));
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(() => {
      if (!document.hidden) refresh();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <section>
      <div className="run-hero">
        <h1>Git / GitHub</h1>
        <p className="muted">輕量讀取本機 git 狀態與 GitHub open issues，依變更檔案數排名；不建立監視器、不寫入 repo。</p>
      </div>

      {overview && !overview.githubTokenConfigured ? (
        <p className="notice">
          尚未設定 GitHub Token；本機 git 狀態仍可查看，issues 需要 token。
          <button type="button" onClick={onOpenSettings}>
            前往設定
          </button>
        </p>
      ) : null}
      {error ? <p className="warn">{error}</p> : null}
      {overview === null ? <p className="muted">載入中…</p> : null}
      {overview && overview.projects.length === 0 ? <p className="muted">還沒有專案資料夾。先到「設定」填寫專案根目錄。</p> : null}

      <ul className="project-list">
        {ranked.map((project, index) => (
          <li key={project.id} className="project-row git-row">
            <div {...headProps(project.folder)}>
              <strong>
                {project.isGitRepo ? `#${index + 1} ` : ""}
                {project.label}
              </strong>
              <span className="muted mono breakable">{project.folder}</span>
            </div>
            <GitSummary project={project} />
            {project.repo ? (
              <a className="mono" href={project.repo.url} target="_blank" rel="noreferrer">
                {project.repo.owner}/{project.repo.repo}
              </a>
            ) : project.isGitRepo ? (
              <span className="muted">origin 不是 GitHub remote，或尚未設定 origin。</span>
            ) : null}
            {project.issueError ? <p className="warn">{project.issueError}</p> : null}
            {project.issues.length > 0 ? (
              <ul className="plain-list git-issues">
                {project.issues.map((issue) => (
                  <li key={issue.id}>
                    <a href={issue.url} target="_blank" rel="noreferrer">
                      #{issue.number} {issue.title}
                    </a>
                    <span className="muted"> {issue.author} · {issue.updatedAt ? formatRelative(issue.updatedAt) : "未知時間"}</span>
                  </li>
                ))}
              </ul>
            ) : project.repo && !project.issueError && !isIssueSkippedFolder(project.folder) ? (
              <p className="muted">沒有 open issues。</p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
};
