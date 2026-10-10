/** 一般設定（通知、保留期限、登入時啟動）與備份還原的共用型別。 */

export interface AppSettings {
  notificationsEnabled: boolean;
  /** 靜音的專案 id：這些專案的新推送不跳桌面通知（事件與規則照常運作）。 */
  mutedProjectIds: number[];
  /** 日誌與事件的保留天數；null = 永久保留。 */
  retentionDays: number | null;
  openAtLogin: boolean;
  /** 開發模式（未打包）不能登錄為登入項目，否則登錄的會是 Electron 本體。 */
  openAtLoginSupported: boolean;
}

export type AppSettingsPatch = Partial<Pick<AppSettings, "notificationsEnabled" | "mutedProjectIds" | "retentionDays" | "openAtLogin">>;

export const RETENTION_CHOICES: ReadonlyArray<{ days: number | null; label: string }> = [
  { days: 7, label: "7 天" },
  { days: 14, label: "14 天" },
  { days: 30, label: "30 天（預設）" },
  { days: 90, label: "90 天" },
  { days: 365, label: "一年" },
  { days: null, label: "永久保留" }
];

export interface BackupFileInfo {
  name: string;
  createdAt: number;
  bytes: number;
}

export interface RestoreSummary {
  settings: number;
  projects: number;
  branchRules: number;
  rules: number;
  terminalMappings: number;
}
