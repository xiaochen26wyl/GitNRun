import { useCallback, useEffect, useState, type DragEvent, type FormEvent } from "react";
import { errorMessage } from "@shared/format";
import { RUN_MANIFEST_FILE, type RunAction, type RunButtonState, type RunOverview, type RunServiceState, type RunTargetView } from "@shared/run";
import { maskedDisplay } from "@shared/secrets";

const REFRESH_MS = 4_000;

const ROLE_LABEL = { backend: "後端", frontend: "前端", desktop: "桌面" } as const;
const STATE_LABEL: Record<RunServiceState, string> = { running: "執行中", starting: "啟動中", stopped: "未啟動" };

const ActionButton = ({ label, state, busy, onClick }: { label: string; state: RunButtonState; busy: boolean; onClick: () => void }) => (
  <span className="run-action">
    <button type="button" disabled={!state.enabled || busy} title={state.reason ?? undefined} onClick={onClick}>
      {label}
    </button>
    {state.reason ? <span className="muted run-reason">{state.reason}</span> : null}
  </span>
);

/**
 * dev 通關帳號／密碼：存起來、能替換、一鍵複製，方便貼到網頁或模擬器。兩個都可以留空。
 * 密碼存在系統金鑰保護的保險庫，畫面只看得到末四碼；複製由主程序寫剪貼簿，這裡拿不到明文。
 */
const PasscodeBox = ({ target, vaultAvailable, onChanged }: { target: RunTargetView; vaultAvailable: boolean; onChanged: () => void }) => {
  // null = 沒有在編輯，顯示已儲存的值；定期刷新不會蓋掉正在輸入的內容。
  const [accountDraft, setAccountDraft] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const { passcode } = target;
  const account = accountDraft ?? target.account;
  const accountChanged = accountDraft !== null && accountDraft.trim() !== target.account;
  const passwordTyped = password.trim() !== "";
  const unreadable = passcode.configured && passcode.state === "unreadable";

  const attempt = async (action: () => Promise<string>) => {
    setBusy(true);
    setNote(null);
    try {
      setNote({ ok: true, text: await action() });
    } catch (actionError) {
      setNote({ ok: false, text: errorMessage(actionError) });
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!accountChanged && !passwordTyped) return;
    void attempt(async () => {
      if (accountChanged) {
        await window.gitNRun.setRunAccount(target.id, accountDraft ?? "");
        setAccountDraft(null);
      }
      if (passwordTyped) {
        await window.gitNRun.setSecret(passcode.name, password);
        // 儲存後立刻清掉輸入框，明文不留在畫面的狀態裡。
        setPassword("");
      }
      return "已儲存";
    });
  };

  const copyAccount = () =>
    attempt(async () => {
      await window.gitNRun.copyText(account.trim());
      return "已複製帳號";
    });

  const copyPassword = () =>
    attempt(async () => {
      await window.gitNRun.copyRunPasscode(target.id);
      return "已複製密碼，60 秒後會自動清除剪貼簿";
    });

  const clearPassword = () =>
    attempt(async () => {
      await window.gitNRun.deleteSecret(passcode.name);
      return "已清除密碼";
    });

  return (
    <form className="run-passcode" onSubmit={save}>
      <strong>Dev 通關帳號／密碼</strong>
      <span className="muted run-passcode-hint">兩個都可以留空；密碼框留空按儲存表示不更動。</span>

      <div className="secret-controls">
        <span className="run-passcode-label">帳號</span>
        <input
          type="text"
          aria-label="Dev 通關帳號"
          value={account}
          placeholder="（未設定）"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          onChange={(event) => setAccountDraft(event.target.value)}
        />
        <button type="button" disabled={busy || account.trim() === ""} onClick={() => void copyAccount()}>
          複製帳號
        </button>
      </div>

      <div className="secret-controls">
        <span className="run-passcode-label">密碼</span>
        <input
          type="password"
          aria-label="Dev 通關密碼"
          value={password}
          placeholder={passcode.configured ? `${maskedDisplay(passcode)}（輸入新值以取代）` : "（未設定）"}
          autoComplete="off"
          spellCheck={false}
          disabled={busy || !vaultAvailable}
          onChange={(event) => setPassword(event.target.value)}
        />
        <button type="button" disabled={busy || !passcode.configured || unreadable} onClick={() => void copyPassword()}>
          複製密碼
        </button>
        <button type="button" disabled={busy || !passcode.configured} onClick={() => void clearPassword()}>
          清除密碼
        </button>
      </div>

      <div className="row-actions">
        <button type="submit" disabled={busy || (!accountChanged && !passwordTyped)}>
          儲存
        </button>
        {unreadable ? <span className="warn">已存的密碼無法解密，請重新輸入</span> : null}
        {!vaultAvailable ? <span className="warn">此電腦無法使用系統金鑰保護，密碼無法儲存（帳號仍可使用）</span> : null}
        {note ? <span className={note.ok ? "ok" : "warn"}>{note.text}</span> : null}
      </div>
    </form>
  );
};

const TargetRow = ({
  target,
  busyKey,
  vaultAvailable,
  onAction,
  onRemove,
  onChanged
}: {
  target: RunTargetView;
  busyKey: string;
  vaultAvailable: boolean;
  onAction: (action: RunAction) => void;
  onRemove: () => void;
  onChanged: () => void;
}) => (
  <li className="project-row run-row">
    <div className="project-head">
      <strong>{target.label}</strong>
      <span className="muted mono">{target.folder}</span>
      {target.manifest === "ok" && !target.trusted ? <span className="badge" title="第一次執行時會先請你確認指令">指令未確認</span> : null}
      {target.manifest === "invalid" ? <span className="warn-badge">描述檔有誤</span> : null}
    </div>

    {target.manifest === "missing" ? <p className="muted">這個專案沒有 <span className="mono">{RUN_MANIFEST_FILE}</span>，無法一鍵啟動。</p> : null}
    {target.errors.length > 0 ? (
      <ul className="plain-list warn">
        {target.errors.slice(0, 5).map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
    ) : null}

    {target.services.length > 0 ? (
      <ul className="plain-list run-services">
        {target.services.map((service) => (
          <li key={service.name} className="run-service">
            <span className={`status-dot ${service.state}`} title={STATE_LABEL[service.state]} />
            <strong>{service.name}</strong>
            <span className="badge">{ROLE_LABEL[service.role]}</span>
            <span className="muted">{STATE_LABEL[service.state]}</span>
            {service.url ? <span className="mono">{service.url}</span> : null}
            <span className="muted mono run-command">{service.command}</span>
          </li>
        ))}
      </ul>
    ) : null}

    <div className="row-actions run-buttons">
      <ActionButton label="一鍵前後端" state={target.buttons.all} busy={busyKey !== ""} onClick={() => onAction("all")} />
      <ActionButton label="開網頁" state={target.buttons.web} busy={busyKey !== ""} onClick={() => onAction("web")} />
      <ActionButton label="開桌面視窗" state={target.buttons.desktop} busy={busyKey !== ""} onClick={() => onAction("desktop")} />
      {target.source === "folder" ? (
        <button type="button" onClick={onRemove}>
          移除
        </button>
      ) : null}
    </div>

    <PasscodeBox target={target} vaultAvailable={vaultAvailable} onChanged={onChanged} />
  </li>
);

export const RunView = () => {
  const [overview, setOverview] = useState<RunOverview | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [dragging, setDragging] = useState(false);

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

  const act = async (target: RunTargetView, action: RunAction) => {
    setError("");
    setBusyKey(`${target.id}:${action}`);
    try {
      const result = await window.gitNRun.runProjectAction(target.id, action);
      setMessage({ ok: result.ok, text: `${target.label}：${result.message}` });
    } catch (actionError) {
      setMessage(null);
      setError(errorMessage(actionError));
    } finally {
      setBusyKey("");
      refresh();
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    for (const file of Array.from(event.dataTransfer.files)) {
      const path = window.gitNRun.pathForFile(file);
      if (path) {
        void window.gitNRun
          .addRunFolder(path)
          .then(refresh)
          .catch((addError) => setError(errorMessage(addError)));
      }
    }
  };

  return (
    <section>
      <p className="muted">
        按下按鈕才會啟動：服務在 iTerm2 的分頁裡執行，port 由 GitNRun 在按下當下配置；要停止就關掉該分頁或按 Ctrl+C。
        {overview && !overview.iterm ? <span className="warn"> 找不到 iTerm2，啟動類按鈕無法使用。</span> : null}
      </p>

      <div
        className={`dropzone run-dropzone ${dragging ? "dragging" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        把專案資料夾拖到這裡加入（已設定本機路徑的專案會自動列出）
      </div>

      {message ? <p className={message.ok ? "ok" : "warn"}>{message.text}</p> : null}
      {error ? <p className="warn">{error}</p> : null}

      {overview === null ? <p className="muted">載入中…</p> : null}
      {overview && overview.targets.length === 0 ? <p className="muted">還沒有專案設定本機路徑，也還沒加入資料夾。</p> : null}
      <ul className="project-list">
        {overview?.targets.map((target) => (
          <TargetRow
            key={target.id}
            target={target}
            busyKey={busyKey}
            vaultAvailable={overview.vaultAvailable}
            onChanged={refresh}
            onAction={(action) => void act(target, action)}
            onRemove={() =>
              void window.gitNRun
                .removeRunFolder(target.id)
                .then(refresh)
                .catch((removeError) => setError(errorMessage(removeError)))
            }
          />
        ))}
      </ul>
    </section>
  );
};
