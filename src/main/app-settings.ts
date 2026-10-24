import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AppSettings, AppSettingsPatch, BackupOverview, DataUsage, RestoreSummary } from "@shared/app-settings";
import { nextBackupAt } from "@main/backup-schedule";
import { BACKUP_KEEP, deleteBackups, exportConfig, importConfig, listBackups, readBackupFile, writeBackup } from "@main/db/backup";
import { readDataUsage } from "@main/db/data-usage";
import type { Db } from "@main/db/database";
import { MAX_RETENTION_DAYS, MIN_RETENTION_DAYS } from "@main/db/retention";
import { DEFAULT_RETENTION_DAYS, SETTING_KEYS, getSetting, setSetting } from "@main/db/settings-repo";
import { UserFacingError } from "@main/errors";

/** 一般設定與備份還原的處理邏輯（與外殼無關，可直接測試）。 */

export interface AppSettingsDeps {
  db: Db;
  backupDir: string;
  now: () => number;
  /** 設定類資料改變（觸發備份）。 */
  onConfigChanged: () => void;
  /** 還原了備份：專案與映射可能都變了，監視器要重新載入。 */
  onRestored: () => void;
}

export interface AppSettingsHandlers {
  get(): AppSettings;
  save(patch: AppSettingsPatch): AppSettings;
  dataUsage(): DataUsage;
  listBackups(): BackupOverview;
  backupNow(): { written: boolean };
  restore(name: string): RestoreSummary;
  deleteBackup(name: string): void;
  deleteAllBackups(): { removed: number };
}

export const createAppSettingsHandlers = (deps: AppSettingsDeps): AppSettingsHandlers => {
  const { db } = deps;

  const current = (): AppSettings => {
    const retention = getSetting<unknown>(db, SETTING_KEYS.retentionDays, DEFAULT_RETENTION_DAYS);
    return {
      retentionDays: retention === null ? null : typeof retention === "number" && Number.isFinite(retention) ? retention : DEFAULT_RETENTION_DAYS
    };
  };

  return {
    get: current,

    save(patch) {
      // 先全部驗證，再一起寫入：有一項不合格就整批不套用。
      if (patch.retentionDays !== undefined && patch.retentionDays !== null) {
        const days = patch.retentionDays;
        if (!Number.isSafeInteger(days) || days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS) {
          throw new UserFacingError(`保留天數需介於 ${MIN_RETENTION_DAYS} 到 ${MAX_RETENTION_DAYS}`);
        }
      }

      if (patch.retentionDays !== undefined) setSetting(db, SETTING_KEYS.retentionDays, patch.retentionDays);

      deps.onConfigChanged();
      return current();
    },

    dataUsage: () => readDataUsage(db),

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
      const files = listBackups(deps.backupDir).flatMap((name) => {
        const info = sizes.get(name);
        return info ? [{ name, createdAt: info.mtimeMs, bytes: info.size }] : [];
      });
      return { files, nextAutoBackupAt: nextBackupAt(deps.now()), keep: BACKUP_KEEP };
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
    },

    deleteBackup(name) {
      // 與還原相同：只認備份資料夾裡、格式正確的檔名，不接受任意路徑。
      if (!listBackups(deps.backupDir).includes(name)) {
        throw new UserFacingError("找不到這份備份");
      }
      try {
        deleteBackups(deps.backupDir, [name]);
      } catch {
        throw new UserFacingError("刪除備份失敗");
      }
    },

    deleteAllBackups() {
      try {
        return { removed: deleteBackups(deps.backupDir, listBackups(deps.backupDir)).length };
      } catch {
        throw new UserFacingError("刪除備份失敗");
      }
    }
  };
};
