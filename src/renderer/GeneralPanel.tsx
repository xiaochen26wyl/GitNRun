import { useCallback, useEffect, useState } from "react";
import { RETENTION_CHOICES, type AppSettings, type BackupFileInfo, type DataCategoryUsage, type DataUsage } from "@shared/app-settings";
import { errorMessage, formatBytes, formatDateTime } from "@shared/format";

const RETENTION_ITEMS: ReadonlyArray<{ key: "events" | "logs" | "aiCalls"; title: string; note: string }> = [
  {
    key: "events",
    title: "事件",
    note: "監視到的每一次推送（含分支建立、刪除），以及各規則針對它的執行結果。清掉後只是少了歷史紀錄，不影響之後的偵測與規則。"
  },
  {
    key: "logs",
    title: "日誌",
    note: "app 自己的運作紀錄（推送、規則、指令、AI、系統），用來排查「為什麼這條規則沒跑」。內容寫入前已遮蔽金鑰等敏感字串。"
  },
  {
    key: "aiCalls",
    title: "AI 呼叫記錄",
    note: "每次呼叫 AI 的用途、模型、用量與回覆。相同輸入會直接取用先前的回覆來省下重複呼叫，這份快取另有自己的保留時間，不受下方選項影響。"
  }
];

const usageText = (usage: DataCategoryUsage): string =>
  usage.count === 0
    ? "目前沒有資料"
    : [
        `${usage.count.toLocaleString("zh-TW")} 筆`,
        usage.bytes === null ? null : `約 ${formatBytes(usage.bytes)}`,
        usage.oldestAt === null ? null : `最早 ${formatDateTime(usage.oldestAt)}`
      ]
        .filter((part) => part !== null)
        .join("、");

/** 一般設定：資料保留期限、專案根目錄，以及設定的備份與還原。 */
export const GeneralPanel = () => {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [usage, setUsage] = useState<DataUsage | null>(null);
  const [backups, setBackups] = useState<BackupFileInfo[]>([]);
  const [confirmingRestore, setConfirmingRestore] = useState<string | null>(null);
  const [root, setRoot] = useState("");
  const [savedRoot, setSavedRoot] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    void window.gitNRun.getAppSettings().then(setSettings);
    void window.gitNRun.getDataUsage().then(setUsage);
    void window.gitNRun.listBackups().then(setBackups);
  }, []);

  useEffect(refresh, [refresh]);

  // 專案根目錄只載入一次：其他設定儲存後的 refresh 不該洗掉還沒按儲存的輸入。
  useEffect(() => {
    void window.gitNRun
      .getDocumentRoot()
      .then((value) => {
        setRoot(value);
        setSavedRoot(value);
      })
      .catch((rootError) => setError(errorMessage(rootError)));
  }, []);

  if (!settings) return null;

  const saveRoot = async () => {
    setMessage("");
    setError("");
    try {
      const value = await window.gitNRun.setDocumentRoot(root);
      setRoot(value);
      setSavedRoot(value);
      setMessage(value === "" ? "已關閉專案根目錄自動掃描" : "已更新專案根目錄");
    } catch (rootError) {
      setError(errorMessage(rootError));
    }
  };

  const run = async (action: () => Promise<unknown>, success: string) => {
    setMessage("");
    setError("");
    try {
      await action();
      setMessage(success);
      refresh();
    } catch (actionError) {
      setError(errorMessage(actionError));
    }
  };

  return (
    <section className="panel">
      <h2>一般</h2>

      <h3>資料保留</h3>
      <p className="muted">
        以下三類資料由 app 自動、持續累積：推送越頻繁、AI 用得越多，這台電腦上的資料庫就越大。沒有人會逐筆去刪，所以由 app 每天自動清掉超過保留天數的資料，
        你只需要決定要留多久。這些資料只存在本機，不會上傳。
      </p>
      <ul className="plain-list retention-list">
        {RETENTION_ITEMS.map((item) => (
          <li key={item.key}>
            <strong>{item.title}</strong>
            <span className="muted">：{usage ? usageText(usage[item.key]) : "讀取中…"}</span>
            <p className="muted">{item.note}</p>
          </li>
        ))}
      </ul>
      {usage ? (
        <p className="muted">
          資料庫檔案共 {formatBytes(usage.databaseBytes)}，其中 {formatBytes(usage.freeBytes)} 是已清掉、等著被新資料重複使用的空間；清理後檔案不會立刻縮小。
        </p>
      ) : null}
      <label className="field">
        事件、日誌與 AI 呼叫記錄保留多久（每天清理一次；選「永久保留」資料會持續增加）
        <select
          value={settings.retentionDays === null ? "forever" : String(settings.retentionDays)}
          onChange={(event) =>
            void run(
              () => window.gitNRun.saveAppSettings({ retentionDays: event.target.value === "forever" ? null : Number(event.target.value) }),
              "已儲存"
            )
          }
        >
          {RETENTION_CHOICES.map((choice) => (
            <option key={String(choice.days)} value={choice.days === null ? "forever" : String(choice.days)}>
              {choice.label}
            </option>
          ))}
          {RETENTION_CHOICES.some((choice) => choice.days === settings.retentionDays) || settings.retentionDays === null ? null : (
            <option value={String(settings.retentionDays)}>{settings.retentionDays} 天</option>
          )}
        </select>
      </label>

      <h3>專案根目錄</h3>
      <p className="muted">Git / GitHub 頁會掃描這個資料夾底下第一層含 .git 的資料夾，自動列為專案；留空 = 不自動掃描。</p>
      <form
        className="row-actions"
        onSubmit={(event) => {
          event.preventDefault();
          void saveRoot();
        }}
      >
        <input className="mono root-input" value={root} onChange={(event) => setRoot(event.target.value)} placeholder="例如 /Users/你/Documents/GitHub" aria-label="專案根目錄" />
        <button type="submit" disabled={root.trim() === savedRoot}>
          儲存
        </button>
      </form>

      <h3>設定備份</h3>
      <p className="muted">
        備份只保存在這台電腦的 app 資料夾，沒有雲端同步，也不會推到 GitHub 或其他服務。備份包含專案、文件捷徑、規則、終端機映射、分支命名規則與設定，
        <strong>不包含任何金鑰</strong>、dev 通關密碼或已確認指令記錄。換機或重灌後如果沒有保留本機資料夾，就需要重新設定。還原後規則一律回到「寫入動作需確認」。
        每天晚上 10 點自動建立一份本機備份（若當時電腦睡眠或關機，下次啟動時補做），保留最近 10 份；也可以按「立即備份」。
      </p>
      <div className="row-actions">
        <button type="button" onClick={() => void run(async () => void (await window.gitNRun.backupNow()), "已備份（內容沒有變動時不會新增檔案）")}>
          立即備份
        </button>
      </div>
      {backups.length === 0 ? <p className="muted">還沒有備份。</p> : null}
      <ul className="plain-list">
        {backups.map((backup) => (
          <li key={backup.name} className="row-actions">
            <span>{formatDateTime(backup.createdAt)}</span>
            <span className="muted">{formatBytes(backup.bytes)}</span>
            {confirmingRestore === backup.name ? (
              <>
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    setConfirmingRestore(null);
                    void run(async () => {
                      const summary = await window.gitNRun.restoreBackup(backup.name);
                      setMessage(`已還原：${summary.projects} 個專案、${summary.rules} 條規則、${summary.terminalMappings} 個映射`);
                    }, "已還原");
                  }}
                >
                  確定還原（會取代現有的規則與映射）
                </button>
                <button type="button" onClick={() => setConfirmingRestore(null)}>
                  取消
                </button>
              </>
            ) : (
              <button type="button" onClick={() => setConfirmingRestore(backup.name)}>
                還原
              </button>
            )}
          </li>
        ))}
      </ul>

      {message ? <p className="ok">{message}</p> : null}
      {error ? <p className="warn pre-line">{error}</p> : null}
    </section>
  );
};

const GITHUB_NEW_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

/** 取得 GitHub Token 的步驟：Git / GitHub 頁要讀 issues 就需要它，貼上的地方是下方的「金鑰」。 */
export const GithubTokenGuide = () => {
  const [error, setError] = useState("");

  const openCreatePage = async () => {
    setError("");
    try {
      await window.gitNRun.openExternalLink(GITHUB_NEW_TOKEN_URL);
    } catch (openError) {
      setError(errorMessage(openError));
    }
  };

  return (
    <section className="panel">
      <h2>取得 GitHub Token</h2>
      <p className="muted">
        Git / GitHub 頁要顯示 open issues 需要 GitHub Token。建議用 fine-grained token，只給讀取權限；GitNRun 不會寫入 GitHub。
      </p>
      <ol className="steps">
        <li>
          登入 GitHub，開啟建立頁面（下方按鈕），或依序點 Settings → Developer settings → Personal access tokens → Fine-grained tokens →
          Generate new token。
        </li>
        <li>Token name 填 GitNRun；Expiration 建議 90 天內；Resource owner 選 repo 所屬的帳號或組織。</li>
        <li>Repository access 選 Only select repositories，只勾要看 issues 的 repo。</li>
        <li>
          Repository permissions 把 <strong>Issues</strong> 設為 Read-only（Metadata 會自動帶入 Read-only）。想讓「監視推送」共用同一把，再把{" "}
          <strong>Contents</strong> 設為 Read-only；其他全部維持 No access。
        </li>
        <li>
          按 Generate token，複製 <code className="mono">github_pat_</code> 開頭的字串，離開頁面後就看不到了。
        </li>
        <li>回到本頁下方「金鑰」的 GitHub Token 欄位貼上，按「儲存」，再按「測試連線」確認。</li>
      </ol>
      <h3>注意事項</h3>
      <ul className="steps">
        <li>repo 屬於組織時，組織可能要求管理者核准 token 才能存取。</li>
        <li>Token 到期或被撤銷後，Git / GitHub 頁會顯示「GitHub token 無法讀取 issues」，重新產生並貼上覆蓋即可。</li>
        <li>不建議使用 classic token：私有 repo 需要 repo 權限，範圍過大。</li>
        <li>Token 以系統 Keychain 保護的方式加密存在本機，儲存後畫面不會再顯示。</li>
      </ul>
      <div className="row-actions">
        <button type="button" onClick={() => void openCreatePage()}>
          在瀏覽器開啟建立頁面
        </button>
      </div>
      {error ? <p className="warn pre-line">{error}</p> : null}
    </section>
  );
};
