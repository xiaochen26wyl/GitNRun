import { useCallback, useEffect, useState } from "react";
import {
  SECRET_LABELS,
  maskedDisplay,
  type FixedSecretName,
  type SecretStatus,
  type SecretTestResult,
  type SecretsOverview
} from "@shared/secrets";
import { HelpTip } from "./HelpTip";

/** 設定頁目前只開放 GitHub Token；其他固定金鑰（AI、Slack、SMTP）沒有對應功能頁，不顯示。 */
const VISIBLE_SECRET_NAMES: readonly FixedSecretName[] = ["github.pat"];

/** 各金鑰標題旁 ⓘ 的說明；權限範圍與 github-token-check.ts 的讀取權限一致。 */
const SECRET_HELP: Partial<Record<FixedSecretName, string>> = {
  "github.pat": "需要 fine-grained token 的讀取權限：Issues: Read、Metadata: Read；監視推送另需 Contents: Read。"
};

interface RowProps {
  status: SecretStatus;
  label: string;
  help?: string;
  disabled: boolean;
  onChanged: () => void;
}

const stateText = (status: SecretStatus): string => {
  if (!status.configured) {
    return "尚未設定";
  }
  return status.state === "unreadable" ? "已存但無法解密，請重新輸入" : `已設定 ${maskedDisplay(status)}`;
};

const SecretRow = ({ status, label, help, disabled, onChanged }: RowProps) => {
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
        <span className="secret-title">
          <strong>{label}</strong>
          {help ? <HelpTip label={`${label}的權限說明`}>{help}</HelpTip> : null}
        </span>
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
      <div className="settings-heading">
        <h2>金鑰</h2>
        <HelpTip label="金鑰說明">
          <p>金鑰以系統 Keychain 保護的方式加密後存在本機。儲存後畫面不會再顯示完整內容，輸入框也會立刻清空。</p>
        </HelpTip>
      </div>
      {overview.available ? null : <p className="warn">此電腦無法使用系統金鑰保護，目前無法儲存金鑰。</p>}
      <ul className="secret-list">
        {VISIBLE_SECRET_NAMES.map((name) => {
          const status = overview.secrets.find((entry) => entry.name === name);
          return status ? (
            <SecretRow
              key={name}
              status={status}
              label={SECRET_LABELS[name]}
              help={SECRET_HELP[name]}
              disabled={!overview.available}
              onChanged={refresh}
            />
          ) : null;
        })}
      </ul>
    </section>
  );
};
