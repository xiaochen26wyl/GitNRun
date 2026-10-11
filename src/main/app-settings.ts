import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AppSettings, AppSettingsPatch, BackupFileInfo, RestoreSummary } from "@shared/app-settings";
import { exportConfig, importConfig, listBackups, readBackupFile, writeBackup } from "@main/db/backup";
import type { Db } from "@main/db/database";
import { MAX_RETENTION_DAYS, MIN_RETENTION_DAYS } from "@main/db/retention";
import { DEFAULT_RETENTION_DAYS, SETTING_KEYS, getSetting, setSetting } from "@main/db/settings-repo";
import { UserFacingError } from "@main/errors";
import { NOTIFICATIONS_ENABLED_KEY, NOTIFICATIONS_MUTED_PROJECTS_KEY, readMutedProjectIds } from "@main/notification-prefs";

/** 一般設定與備份還原的處理邏輯（與 Electron 無關，可直接測試）。 */

export interface LoginItemApi {
  supported: boolean;
  get(): boolean;
  set(enabled: boolean): void;
}

export interface AppSettingsDeps {
  db: Db;
  backupDir: string;
  loginItem: LoginItemApi;
  now: () => number;
  /** 設定類資料改變（觸發備份）。 */
  onConfigChanged: () => void;
  /** 還原了備份：專案與映射可能都變了，監視器要重新載入。 */
  onRestored: () => void;
}

export interface AppSettingsHandlers {
  get(): AppSettings;
  save(patch: AppSettingsPatch): AppSettings;
  listBackups(): BackupFileInfo[];
  backupNow(): { written: boolean };
  restore(name: string): RestoreSummary;
}

const MAX_MUTED = 500;

export const createAppSettingsHandlers = (deps: AppSettingsDeps): AppSettingsHandlers => {
  const { db } = deps;

  const current = (): AppSettings => {
    const retention = getSetting<unknown>(db, SETTING_KEYS.retentionDays, DEFAULT_RETENTION_DAYS);
    return {
      notificationsEnabled: getSetting<boolean>(db, NOTIFICATIONS_ENABLED_KEY, true) !== false,
      mutedProjectIds: readMutedProjectIds(db),
      retentionDays: retention === null ? null : typeof retention === "number" && Number.isFinite(retention) ? retention : DEFAULT_RETENTION_DAYS,
      openAtLogin: deps.loginItem.supported && deps.loginItem.get(),
      openAtLoginSupported: deps.loginItem.supported
    };
  };

  return {
    get: current,

    save(patch) {
      // 先全部驗證，再一起寫入：有一項不合格就整批不套用。
      if (patch.notificationsEnabled !== undefined && typeof patch.notificationsEnabled !== "boolean") {
        throw new UserFacingError("通知開關不正確");
      }
      if (patch.mutedProjectIds !== undefined) {
        const ids = patch.mutedProjectIds;
        if (!Array.isArray(ids) || ids.length > MAX_MUTED || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
          throw new UserFacingError("靜音專案清單不正確");
        }
      }
      if (patch.retentionDays !== undefined && patch.retentionDays !== null) {
        const days = patch.retentionDays;
        if (!Number.isSafeInteger(days) || days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS) {
          throw new UserFacingError(`保留天數需介於 ${MIN_RETENTION_DAYS} 到 ${MAX_RETENTION_DAYS}`);
        }
      }
      if (patch.openAtLogin !== undefined) {
        if (typeof patch.openAtLogin !== "boolean") throw new UserFacingError("登入時啟動的設定不正確");
        if (patch.openAtLogin && !deps.loginItem.supported) {
          throw new UserFacingError("開發模式不能設為登入時啟動，請在打包後的 App 使用");
        }
      }

      if (patch.notificationsEnabled !== undefined) setSetting(db, NOTIFICATIONS_ENABLED_KEY, patch.notificationsEnabled);
      if (patch.mutedProjectIds !== undefined) setSetting(db, NOTIFICATIONS_MUTED_PROJECTS_KEY, [...new Set(patch.mutedProjectIds)]);
      if (patch.retentionDays !== undefined) setSetting(db, SETTING_KEYS.retentionDays, patch.retentionDays);
      if (patch.openAtLogin !== undefined && deps.loginItem.supported) deps.loginItem.set(patch.openAtLogin);

      deps.onConfigChanged();
      return current();
    },

    listBackups() {
      const sizes = new Map(
        (() => {
          try {
            return readdirSync(deps.backupDir).map((name) => [name, statSync(join(deps.backupDir, name))] as const);
          } catch {
            return [];
          }
        })()
      );
      return listBackups(deps.backupDir).flatMap((name) => {
        const info = sizes.get(name);
        return info ? [{ name, createdAt: info.mtimeMs, bytes: info.size }] : [];
      });
    },

    backupNow() {
      const result = writeBackup(deps.backupDir, exportConfig(db, deps.now()), { now: deps.now() });
      return { written: result.written };
    },

    restore(name) {
      // 只能還原備份資料夾裡、由本程式產生的檔案；不接受任意路徑。
      if (!listBackups(deps.backupDir).includes(name)) {
        throw new UserFacingError("找不到這份備份");
      }
      let summary: RestoreSummary;
      try {
        summary = importConfig(db, readBackupFile(join(deps.backupDir, name)), deps.now());
      } catch (error) {
        throw new UserFacingError(error instanceof Error && error.name === "BackupValidationError" ? "這份備份的內容不正確，無法還原" : "讀取備份失敗");
      }
      deps.onRestored();
      return summary;
    }
  };
};
