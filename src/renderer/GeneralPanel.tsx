import { useCallback, useEffect, useState } from "react";
import { RETENTION_CHOICES, type AppSettings, type BackupFileInfo } from "@shared/app-settings";
import { errorMessage, formatDateTime } from "@shared/format";
import type { Project } from "@shared/projects";

const kilobytes = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** 一般設定：通知偏好、資料保留期限、登入時啟動，以及設定的備份與還原。 */
export const GeneralPanel = () => {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [backups, setBackups] = useState<BackupFileInfo[]>([]);
  const [confirmingRestore, setConfirmingRestore] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    void window.gitNRun.getAppSettings().then(setSettings);
    void window.gitNRun.listBackups().then(setBackups);
    void window.gitNRun.listProjects().then(setProjects);
  }, []);

  useEffect(refresh, [refresh]);

  if (!settings) return null;

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

  const toggleMuted = (projectId: number, muted: boolean) =>
    run(
      () =>
        window.gitNRun.saveAppSettings({
          mutedProjectIds: muted ? [...settings.mutedProjectIds, projectId] : settings.mutedProjectIds.filter((id) => id !== projectId)
        }),
      "已儲存"
    );

  return (
    <section className="panel">
      <h2>一般</h2>

      <h3>通知</h3>
      <label className="inline-check">
        <input type="checkbox" checked={settings.notificationsEnabled} onChange={(event) => void run(() => window.gitNRun.saveAppSettings({ notificationsEnabled: event.target.checked }), "已儲存")} />
        新的推送時跳出桌面通知
      </label>
      {projects.length > 0 ? (
        <>
          <p className="muted">靜音的專案不會跳通知（事件、規則照常運作）。規則自己發送的通知，要停用就停用那條規則或移除通知動作。</p>
          <ul className="plain-list">
            {projects.map((project) => (
              <li key={project.id}>
                <label className="inline-check">
                  <input
                    type="checkbox"
                    disabled={!settings.notificationsEnabled}
                    checked={settings.mutedProjectIds.includes(project.id)}
                    onChange={(event) => void toggleMuted(project.id, event.target.checked)}
                  />
                  靜音 {project.name}
                </label>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <h3>資料保留</h3>
      <label className="field">
        事件、日誌與 AI 呼叫記錄保留多久（每天清理一次）
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

      <h3>啟動</h3>
      <label className="inline-check">
        <input
          type="checkbox"
          disabled={!settings.openAtLoginSupported}
          checked={settings.openAtLogin}
          onChange={(event) => void run(() => window.gitNRun.saveAppSettings({ openAtLogin: event.target.checked }), "已儲存")}
        />
        登入 macOS 時自動啟動（只在托盤執行，不彈出視窗）
      </label>
      {settings.openAtLoginSupported ? null : <p className="muted">開發模式無法設定；請在打包後的 App 使用。</p>}

      <h3>設定備份</h3>
      <p className="muted">
        備份包含專案、規則、終端機映射、分支命名規則與設定，<strong>不包含任何金鑰</strong>（換機或重裝後要重新輸入）。還原後規則一律回到「寫入動作需確認」。
        啟動時與設定變更後會自動備份，保留最近 10 份。
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
            <span className="muted">{kilobytes(backup.bytes)}</span>
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
