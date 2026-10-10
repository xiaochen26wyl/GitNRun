import { useState } from "react";
import { OFFLINE_REASON_TEXT, type AiResult, type ConflictReport, type OutgoingPreview } from "@shared/ai";
import { errorMessage } from "@shared/format";
import type { Project } from "@shared/projects";

const SOURCE_BADGE = { ai: "AI", cache: "AI（快取）", offline: "本機規則" } as const;

/** AI 或本機規則的結果；本機規則會同時說明為什麼沒有用 AI。 */
export const AiResultView = ({ result, copyable = false }: { result: AiResult; copyable?: boolean }) => {
  const [copied, setCopied] = useState(false);
  return (
    <div className="subpanel">
      <div>
        <span className={`badge ${result.source === "offline" ? "warn-badge" : ""}`}>{SOURCE_BADGE[result.source]}</span>
        {result.model ? <span className="muted mono"> {result.model}</span> : null}
        {result.reason ? <span className="muted"> — {OFFLINE_REASON_TEXT[result.reason]}</span> : null}
      </div>
      {result.text ? <pre className="output">{result.text}</pre> : null}
      {copyable && result.text ? (
        <div>
          <button
            type="button"
            onClick={() =>
              void window.gitNRun.copyText(result.text).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
            }
          >
            {copied ? "已複製" : "複製"}
          </button>
        </div>
      ) : null}
    </div>
  );
};

const PreviewView = ({ preview }: { preview: OutgoingPreview }) => (
  <div className="subpanel">
    <p>
      會送給 <strong>{preview.provider}</strong>（<span className="mono">{preview.model || "尚未設定模型"}</span>）的內容：{preview.files.length} 個檔案、
      {preview.bytes} 位元組{preview.truncated ? "（超過上限，已截斷）" : ""}
    </p>
    {preview.excludedFiles.length > 0 ? <p className="muted">內容不會送出（排除清單）：{preview.excludedFiles.join("、")}</p> : null}
    {preview.maskedCount > 0 ? <p className="warn">送出前已遮蔽 {preview.maskedCount} 處疑似密鑰。</p> : null}
    <details>
      <summary>查看實際送出的差異內容</summary>
      <pre className="output">{preview.diff || "（沒有內容）"}</pre>
    </details>
  </div>
);

/** 針對專案尚未提交的變更：先預覽會送出什麼，再產生 commit 訊息。 */
export const CommitMessagePanel = ({ project, onClose }: { project: Project; onClose: () => void }) => {
  const [preview, setPreview] = useState<OutgoingPreview | null | undefined>(undefined);
  const [result, setResult] = useState<AiResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (actionError) {
      setError(errorMessage(actionError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="subpanel">
      <div className="project-head">
        <strong>commit 訊息：{project.name}</strong>
        <button type="button" onClick={onClose}>
          關閉
        </button>
      </div>
      {project.aiEnabled ? null : <p className="warn">這個專案尚未允許 AI 分析，產生時會改用本機規則（只看檔案路徑）。</p>}
      <div className="row-actions">
        <button type="button" disabled={busy} onClick={() => void run(async () => setPreview(await window.gitNRun.previewAiCommit(project.id)))}>
          預覽會送出什麼
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              setResult(await window.gitNRun.generateCommitMessage(project.id));
            })
          }
        >
          產生 commit 訊息
        </button>
      </div>
      {preview === null ? <p className="muted">目前沒有可提交的變更。</p> : null}
      {preview ? <PreviewView preview={preview} /> : null}
      {result ? <AiResultView result={result} copyable /> : null}
      {error ? <p className="warn">{error}</p> : null}
    </div>
  );
};

/** 預測目前分支與 origin/<分支> 合併是否會衝突（本機 git 判斷，AI 只負責解釋）。 */
export const ConflictPanel = ({ project, onClose }: { project: Project; onClose: () => void }) => {
  const [against, setAgainst] = useState("");
  const [report, setReport] = useState<ConflictReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async () => {
    setBusy(true);
    setError("");
    try {
      setReport(await window.gitNRun.predictConflicts(project.id, against.trim() === "" ? undefined : against.trim()));
    } catch (runError) {
      setReport(null);
      setError(errorMessage(runError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="subpanel">
      <div className="project-head">
        <strong>預測合併衝突：{project.name}</strong>
        <button type="button" onClick={onClose}>
          關閉
        </button>
      </div>
      <p className="muted">比較目前分支與最近一次 fetch 下來的 origin/分支；需要 git 2.38 以上。不會改動你的工作區。</p>
      <div className="filters">
        <input aria-label="比對分支" placeholder={`比對分支（預設 ${project.defaultBranch ?? "預設分支"}）`} value={against} onChange={(event) => setAgainst(event.target.value)} />
        <button type="button" disabled={busy} onClick={() => void run()}>
          預測
        </button>
      </div>
      {error ? <p className="warn">{error}</p> : null}
      {report?.clean ? <p className="ok">預測合併不會有衝突。</p> : null}
      {report && !report.clean ? (
        <>
          <p className="warn">預測會有 {report.files.length} 個檔案衝突：</p>
          <ul className="plain-list">
            {report.files.map((file) => (
              <li key={file} className="mono">
                {file}
              </li>
            ))}
          </ul>
          {report.explanation ? <AiResultView result={report.explanation} /> : null}
          {report.detail ? (
            <details>
              <summary>git 的說明</summary>
              <pre className="output">{report.detail}</pre>
            </details>
          ) : null}
        </>
      ) : null}
    </div>
  );
};

/** 事件詳情裡的 AI 摘要與推送建議。 */
export const EventAiActions = ({ eventId }: { eventId: number }) => {
  const [result, setResult] = useState<{ title: string; value: AiResult } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async (title: string, action: () => Promise<AiResult>) => {
    setBusy(true);
    setError("");
    try {
      setResult({ title, value: await action() });
    } catch (runError) {
      setError(errorMessage(runError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h4>AI 助手</h4>
      <div className="row-actions">
        <button type="button" disabled={busy} onClick={() => void run("摘要", () => window.gitNRun.summarizeEventWithAi(eventId))}>
          摘要
        </button>
        <button type="button" disabled={busy} onClick={() => void run("推送建議", () => window.gitNRun.suggestForEvent(eventId))}>
          推送建議
        </button>
      </div>
      {error ? <p className="warn">{error}</p> : null}
      {result ? (
        <>
          <strong>{result.title}</strong>
          <AiResultView result={result.value} />
        </>
      ) : null}
    </div>
  );
};
