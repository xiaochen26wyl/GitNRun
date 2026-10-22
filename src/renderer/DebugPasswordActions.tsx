import { useState } from "react";
import { errorMessage } from "@shared/format";
import { passcodeProblem, passcodeStateText, type PasscodeBinding, type RunTargetView } from "@shared/run";

/** Debug 密碼的來源與設定：密碼只留在專案的環境檔，GitNRun 只讀取；這裡只管「讀哪個檔的哪個鍵」。 */
export const DebugPasswordActions = ({
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
  const recheck = (): Promise<void> =>
    perform(() => window.gitNRun.recheckRunPasscode(target.id));

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
        {open ? "取消動作" : "設定密碼"}
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
              <button type="button" disabled={busy} onClick={() => void recheck()}>
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
              <div className="run-password-row">
                <button type="button" disabled={busy} onClick={() => void recheck()}>
                  重新偵測
                </button>
                <span className="muted">偵測 .env、.env.local、.dev.vars 裡的 DEBUG_／DEV_／LOCAL_ 開頭、PASSWORD 結尾的鍵；只找到一個會自動綁定。</span>
              </div>
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
