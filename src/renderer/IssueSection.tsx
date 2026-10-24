import { useCallback, useState, type ReactNode } from "react";
import {
  ISSUE_PREVIEW_COUNT,
  parseIssueDisplayPref,
  planIssueSection,
  serializeIssueDisplayPref,
  type IssueFeed,
  type IssueSectionPlan
} from "@shared/git-lite";

const DISPLAY_PREF_KEY = "gitnrun.run.showIssues";

/** 「在專案下方顯示 GitHub issues」的偏好：只是這台機器上的檢視設定，存在 localStorage；讀寫失敗就用預設（開啟）。 */
export const useIssueDisplayPref = (): [boolean, (next: boolean) => void] => {
  const [enabled, setEnabled] = useState(() => {
    try {
      return parseIssueDisplayPref(localStorage.getItem(DISPLAY_PREF_KEY));
    } catch {
      return parseIssueDisplayPref(null);
    }
  });

  const update = useCallback((next: boolean) => {
    setEnabled(next);
    try {
      localStorage.setItem(DISPLAY_PREF_KEY, serializeIssueDisplayPref(next));
    } catch {
      // 寫不進去就只在這次執行期間生效。
    }
  }, []);

  return [enabled, update];
};

/** 視窗層不允許新視窗，所以連結一律走主程序的白名單開啟，不使用 target="_blank"。 */
const ExternalLink = ({ url, className, children }: { url: string; className?: string; children: ReactNode }) => (
  <a
    href={url}
    className={className}
    onClick={(event) => {
      event.preventDefault();
      void window.gitNRun.openExternalLink(url).catch(() => undefined);
    }}
  >
    {children}
  </a>
);

const IssueIcon = () => (
  <svg className="issue-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <circle cx="8" cy="8" r="6.25" />
    <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
  </svg>
);

const WarnIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 2 15 14H1z" />
    <path d="M8 6.5v3.5M8 12v.01" />
  </svg>
);

const IssueHead = ({ count, emptyCount, repo }: { count?: string; emptyCount?: boolean; repo?: { owner: string; repo: string; url: string } }) => (
  <div className="issue-head">
    <div className="issue-title-row">
      <IssueIcon />
      <h3>GitHub Issues</h3>
      {count === undefined ? null : <span className={emptyCount ? "issue-count empty" : "issue-count"}>{count}</span>}
    </div>
    {repo ? (
      <ExternalLink url={`${repo.url}/issues`} className="issue-repo mono">
        {repo.owner}/{repo.repo} ↗
      </ExternalLink>
    ) : null}
  </div>
);

const Skeleton = () => (
  <div className="issue-skeleton" aria-hidden="true">
    <span />
    <span />
    <span />
  </div>
);

/** 一個專案卡片下方的 GitHub issues 區塊；各狀態的判斷都在 planIssueSection，這裡只負責畫。 */
export const IssueSection = ({
  feed,
  folder,
  label,
  onRetry,
  onOpenSettings
}: {
  feed: IssueFeed;
  folder: string;
  label: string;
  onRetry: () => void;
  onOpenSettings: () => void;
}) => {
  const [expanded, setExpanded] = useState(false);
  const plan: IssueSectionPlan = planIssueSection(feed, folder, expanded);
  if (plan.kind === "hidden") return null;

  let body: ReactNode;
  let head: ReactNode = <IssueHead />;
  switch (plan.kind) {
    case "loading":
      head = (
        <div className="issue-head">
          <div className="issue-title-row">
            <IssueIcon />
            <h3>GitHub Issues</h3>
            <span className="muted">載入中…</span>
          </div>
        </div>
      );
      body = <Skeleton />;
      break;
    case "no-github":
      body = <p className="muted issue-note">origin 不是 GitHub remote，或尚未設定 origin。</p>;
      break;
    case "no-token":
      body = (
        <p className="notice">
          {plan.message}；issues 需要 token。
          <button type="button" onClick={onOpenSettings}>
            前往設定
          </button>
        </p>
      );
      break;
    case "error":
      body = (
        <p className="warn issue-state">
          <WarnIcon />
          <span>{plan.message}</span>
          {plan.action === "settings" ? (
            <button type="button" className="ghost" onClick={onOpenSettings}>
              前往設定
            </button>
          ) : null}
          {plan.action === "retry" ? (
            <button type="button" className="ghost" onClick={onRetry}>
              重試
            </button>
          ) : null}
        </p>
      );
      break;
    case "empty":
      head = <IssueHead count={plan.countLabel} emptyCount repo={plan.repo} />;
      body = <p className="muted issue-note">沒有 open issues。</p>;
      break;
    case "list":
      head = <IssueHead count={plan.countLabel} repo={plan.repo} />;
      body = (
        <>
          <ul className="issue-list">
            {plan.visible.map((issue) => (
              <li key={issue.id} className="issue-item">
                <span className="issue-number mono">#{issue.number}</span>
                <div className="issue-body">
                  <ExternalLink url={issue.url} className="issue-link">
                    {issue.title}
                  </ExternalLink>
                  <div className="muted">{issue.author}</div>
                </div>
              </li>
            ))}
          </ul>
          <div className="issue-foot">
            {plan.hiddenCount > 0 ? (
              <button type="button" className="ghost" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
                {expanded ? `收合，只看最近 ${ISSUE_PREVIEW_COUNT} 筆` : `再顯示 ${plan.hiddenCount} 筆`}
              </button>
            ) : null}
            <ExternalLink url={`${plan.repo.url}/issues`} className="issue-all muted">
              在 GitHub 看全部 ↗
            </ExternalLink>
          </div>
        </>
      );
      break;
  }

  return (
    <section className="issue-section" aria-label={`${label} 的 GitHub issues`} aria-busy={plan.kind === "loading"}>
      {head}
      {body}
    </section>
  );
};
