import { useCallback, useEffect, useState } from "react";
import {
  FIXED_SECRET_NAMES,
  SECRET_LABELS,
  maskedDisplay,
  type SecretStatus,
  type SecretTestResult,
  type SecretsOverview
} from "@shared/secrets";

interface RowProps {
  status: SecretStatus;
  label: string;
  disabled: boolean;
  onChanged: () => void;
}

const stateText = (status: SecretStatus): string => {
  if (!status.configured) {
    return "尚未設定";
  }
  return status.state === "unreadable" ? "已存但無法解密，請重新輸入" : `已設定 ${maskedDisplay(status)}`;
};

const SecretRow = ({ status, label, disabled, onChanged }: RowProps) => {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [testResult, setTestResult] = useState<SecretTestResult | null>(null);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "操作失敗");
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      await window.gitNRun.setSecret(status.name, value);
      // 儲存後立刻清掉輸入框，明文不留在畫面的狀態裡。
      setValue("");
      setTestResult(null);
      onChanged();
    });

  const remove = () =>
    run(async () => {
      await window.gitNRun.deleteSecret(status.name);
      setTestResult(null);
      onChanged();
    });

  const test = () =>
    run(async () => {
      setTestResult(await window.gitNRun.testSecret(status.name));
    });

  return (
    <li className="secret-row">
      <div className="secret-head">
        <strong>{label}</strong>
        <span className={status.state === "unreadable" ? "warn" : "muted"}>{stateText(status)}</span>
      </div>
      <div className="secret-controls">
        <input
          type="password"
          value={value}
          placeholder={status.configured ? "輸入新值以取代" : "貼上金鑰"}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled || busy}
          onChange={(event) => setValue(event.target.value)}
        />
        <button type="button" disabled={disabled || busy || value.trim() === ""} onClick={save}>
          儲存
        </button>
        <button type="button" disabled={busy || !status.configured} onClick={test}>
          測試連線
        </button>
        <button type="button" disabled={busy || !status.configured} onClick={remove}>
          刪除
        </button>
      </div>
      {message ? <p className="warn">{message}</p> : null}
      {testResult ? (
        <div>
          <p className={testResult.ok ? "ok" : "warn"}>{testResult.message}</p>
          {testResult.warnings.map((warning) => (
            <p key={warning} className="warn">
              {warning}
            </p>
          ))}
        </div>
      ) : null}
    </li>
  );
};

export const SecretsPanel = () => {
  const [overview, setOverview] = useState<SecretsOverview | null>(null);

  const refresh = useCallback(() => {
    void window.gitNRun.getSecretsOverview().then(setOverview);
  }, []);

  useEffect(refresh, [refresh]);

  if (!overview) {
    return null;
  }

  return (
    <section className="panel">
      <h2>金鑰</h2>
      <p className="muted">金鑰以系統 Keychain 保護的方式加密後存在本機，儲存後畫面上不會再顯示完整內容。</p>
      {overview.available ? null : (
        <p className="warn">此電腦無法使用系統金鑰保護，為了安全，所有金鑰都無法儲存。</p>
      )}
      <ul className="secret-list">
        {FIXED_SECRET_NAMES.map((name) => {
          const status = overview.secrets.find((entry) => entry.name === name);
          return status ? (
            <SecretRow
              key={name}
              status={status}
              label={SECRET_LABELS[name]}
              disabled={!overview.available}
              onChanged={refresh}
            />
          ) : null;
        })}
      </ul>
    </section>
  );
};
