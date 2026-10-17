import { useCallback, useEffect, useState } from "react";
import { RETENTION_CHOICES, type AppSettings, type BackupOverview, type DataCategoryUsage, type DataUsage } from "@shared/app-settings";
import { errorMessage, formatBytes, formatDateTime } from "@shared/format";
import { HelpTip } from "./HelpTip";

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
    note: "每次呼叫 AI 的用途、模型、用量與回覆。相同輸入會直接取用先前的回覆來省下重複呼叫，這份快取另有自己的保留時間，不受保留期限設定影響。"
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

/** 備份區同一時間只開一個確認列：還原、刪除單份、全部刪除共用。 */
type BackupConfirm = { kind: "restore" | "delete"; name: string } | { kind: "delete-all" };

/** 結果訊息所屬的區塊：保留期限、專案根目錄、設定備份。 */
type Section = "retention" | "root" | "backup";
type Notice = { section: Section; tone: "ok" | "error"; text: string };

/** 一般設定：資料保留期限、專案根目錄，以及設定的備份、還原與刪除。 */
export const GeneralPanel = () => {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [usage, setUsage] = useState<DataUsage | null>(null);
  const [overview, setOverview] = useState<BackupOverview | null>(null);
  const [confirming, setConfirming] = useState<BackupConfirm | null>(null);
  const [root, setRoot] = useState("");
  const [savedRoot, setSavedRoot] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);

  const refresh = useCallback(() => {
    void window.gitNRun.getAppSettings().then(setSettings);
    void window.gitNRun.getDataUsage().then(setUsage);
    void window.gitNRun.listBackups().then(setOverview);
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
      .catch((rootError) => setNotice({ section: "root", tone: "error", text: errorMessage(rootError) }));
  }, []);

  if (!settings) return null;

  const saveRoot = async () => {
    setNotice(null);
    try {
      const value = await window.gitNRun.setDocumentRoot(root);
      setRoot(value);
      setSavedRoot(value);
      setNotice({ section: "root", tone: "ok", text: value === "" ? "已關閉自動掃描" : "已更新專案根目錄" });
    } catch (rootError) {
      setNotice({ section: "root", tone: "error", text: errorMessage(rootError) });
    }
  };

  const backups = overview?.files ?? [];

  const run = async <T,>(section: Section, action: () => Promise<T>, success: string | ((result: T) => string)) => {
    setNotice(null);
    try {
      const result = await action();
      setNotice({ section, tone: "ok", text: typeof success === "function" ? success(result) : success });
      refresh();
    } catch (actionError) {
      setNotice({ section, tone: "error", text: errorMessage(actionError) });
    }
  };

  // 結果只顯示在所屬區塊的控制項下方，不集中到面板底部。
  const noticeFor = (section: Section) =>
    notice && notice.section === section ? <p className={notice.tone === "ok" ? "ok" : "warn pre-line"}>{notice.text}</p> : null;

  return (
    <section className="panel">
      <h2>一般</h2>

      <div className="settings-heading">
        <h3>資料保留</h3>
        <HelpTip label="資料保留說明">
          <p>事件、日誌與 AI 呼叫記錄由 app 持續累積，每天自動清掉超過保留天數的資料。這些資料只存在這台電腦，不會上傳。</p>
          <ul>
            {RETENTION_ITEMS.map((item) => (
              <li key={item.key}>
                <strong>{item.title}</strong>：{item.note}
              </li>
            ))}
          </ul>
          <p>清理後資料庫檔案不會立刻縮小；選「永久保留」資料會持續增加。</p>
        </HelpTip>
      </div>
      <label className="field">
        保留期限（每天自動清理）
        <select
          value={settings.retentionDays === null ? "forever" : String(settings.retentionDays)}
          onChange={(event) =>
            void run(
              "retention",
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
      {noticeFor("retention")}
      {usage ? (
        <ul className="plain-list">
          {RETENTION_ITEMS.map((item) => (
            <li key={item.key}>
              <strong>{item.title}</strong>
              <span className="muted">：{usageText(usage[item.key])}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">讀取中…</p>
      )}
      {usage ? (
        <p className="muted">
          資料庫共 {formatBytes(usage.databaseBytes)}，其中 {formatBytes(usage.freeBytes)} 可重新使用。
        </p>
      ) : null}

      <div className="settings-heading">
        <h3>專案根目錄</h3>
        <HelpTip label="專案根目錄說明">
          <p>這個資料夾底下第一層含 .git 的資料夾，會被掃描來讀取對應的 GitHub issues。</p>
        </HelpTip>
      </div>
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
      {noticeFor("root")}
      <p className="muted">留空即不自動掃描。</p>

      <div className="settings-heading">
        <h3>設定備份</h3>
        <HelpTip label="設定備份說明">
          <p>
            備份只存在這台電腦的 app 資料夾，沒有雲端同步，也不會推到 GitHub 或其他服務。備份包含專案、文件捷徑、規則、終端機映射、分支命名規則與設定，
            <strong>不包含任何金鑰</strong>、dev 通關密碼或已確認指令記錄。
          </p>
          <p>換機或重灌後如果沒有保留本機資料夾，就需要重新設定。還原會取代現有的規則與映射，規則一律回到「寫入動作需確認」。</p>
          {overview ? (
            <p>
              每天 22:00 自動備份一次（若當時電腦睡眠或關機，下次啟動時補做）。內容沒有變動時不會新增檔案，最多保留最近 {overview.keep} 份，超過會自動刪掉最舊的。
            </p>
          ) : null}
        </HelpTip>
      </div>
      <div className="row-actions">
        <button type="button" onClick={() => void run("backup", async () => void (await window.gitNRun.backupNow()), "已備份")}>
          立即備份
        </button>
        {confirming?.kind === "delete-all" ? (
          <>
            <button
              type="button"
              className="danger"
              onClick={() => {
                setConfirming(null);
                void run("backup", () => window.gitNRun.deleteAllBackups(), (result) => `已刪除全部 ${result.removed} 份備份`);
              }}
            >
              確定刪除全部 {backups.length} 份（無法復原）
            </button>
            <button type="button" onClick={() => setConfirming(null)}>
              取消
            </button>
          </>
        ) : (
          <button type="button" disabled={backups.length === 0} onClick={() => setConfirming({ kind: "delete-all" })}>
            全部刪除
          </button>
        )}
      </div>
      {noticeFor("backup")}
      {overview ? (
        <p className="muted">
          下次自動備份 {formatDateTime(overview.nextAutoBackupAt)}
          {backups[0] ? `；最近一份 ${formatDateTime(backups[0].createdAt)}` : null}
        </p>
      ) : null}
      {backups.length === 0 ? <p className="muted">還沒有備份。</p> : null}
      <ul className="plain-list">
        {backups.map((backup) => (
          <li key={backup.name} className="row-actions">
            <span>{formatDateTime(backup.createdAt)}</span>
            <span className="muted">{formatBytes(backup.bytes)}</span>
            {confirming && confirming.kind !== "delete-all" && confirming.name === backup.name ? (
              <>
                {confirming.kind === "restore" ? (
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      setConfirming(null);
                      void run(
                        "backup",
                        () => window.gitNRun.restoreBackup(backup.name),
                        (summary) => `已還原：${summary.projects} 個專案、${summary.rules} 條規則、${summary.terminalMappings} 個映射`
                      );
                    }}
                  >
                    確定還原（會取代現有的規則與映射）
                  </button>
                ) : (
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      setConfirming(null);
                      void run("backup", () => window.gitNRun.deleteBackup(backup.name), "已刪除這份備份");
                    }}
                  >
                    確定刪除（無法復原）
                  </button>
                )}
                <button type="button" onClick={() => setConfirming(null)}>
                  取消
                </button>
              </>
            ) : (
              <>
                <button type="button" onClick={() => setConfirming({ kind: "restore", name: backup.name })}>
                  還原
                </button>
                <button type="button" onClick={() => setConfirming({ kind: "delete", name: backup.name })}>
                  刪除
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
};
