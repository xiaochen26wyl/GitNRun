import { useState } from "react";
import { errorMessage } from "@shared/format";
import type { RunTargetView } from "@shared/run";
import { accountCopyState, accountDraftOf } from "@shared/run-account";

/** Debug 帳號（通常是 email）：存在 GitNRun 的設定裡，不是密鑰，可以直接複製。密碼的來源另見 DebugPasswordActions。 */
export const DebugAccountActions = ({
  target,
  onChanged,
  onMessage
}: {
  target: RunTargetView;
  onChanged: () => void;
  onMessage: (ok: boolean, text: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const { canCopy, reason } = accountCopyState(target.account);

  const copy = async (): Promise<void> => {
    setBusy(true);
    try {
      // 渲染層的瀏覽器剪貼簿被 session lockdown 拒絕，走主程序的 IPC 寫入。
      await window.gitNRun.copyText(target.account);
      onMessage(true, `${target.label}：已複製 Debug 帳號`);
    } catch (cause) {
      onMessage(false, `${target.label}：${errorMessage(cause)}`);
    } finally {
      setBusy(false);
    }
  };

  const save = async (input: string, done: string): Promise<void> => {
    const parsed = accountDraftOf(input);
    if (!parsed.ok) {
      setError(parsed.reason);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await window.gitNRun.setRunAccount(target.id, parsed.account);
      onChanged();
      onMessage(true, `${target.label}：${done}`);
      setOpen(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="run-password-actions">
      <button type="button" disabled={!canCopy || busy} title={canCopy ? undefined : reason} onClick={() => void copy()}>
        複製 Debug 帳號
      </button>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setDraft(target.account);
          setError("");
          setOpen(!open);
        }}
      >
        {open ? "取消動作" : "設定帳號"}
      </button>
      {open ? (
        <div className="run-password-panel">
          <form
            className="run-password-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save(draft, draft.trim() === "" ? "已清除 Debug 帳號" : "已儲存 Debug 帳號");
            }}
          >
            <input value={draft} placeholder="例如 dev@example.com" aria-label={`${target.label} Debug 帳號`} autoComplete="off" spellCheck={false} onChange={(event) => setDraft(event.target.value)} />
            <button type="submit" disabled={busy}>
              儲存帳號
            </button>
            {target.account !== "" ? (
              <button type="button" disabled={busy} onClick={() => void save("", "已清除 Debug 帳號")}>
                清除帳號
              </button>
            ) : null}
          </form>
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
