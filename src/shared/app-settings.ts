/** 一般設定（保留期限）與備份還原的共用型別。 */

export interface AppSettings {
  /** 日誌與事件的保留天數；null = 永久保留。 */
  retentionDays: number | null;
  /** 專案與 App 的手動排序（run-order 序列化字串）；從未存過是 null。 */
  runOrder: string | null;
  /** 各頁籤的排序模式（run-order 序列化字串）；從未存過是 null。 */
  runSortModes: string | null;
  /** 頁籤自訂名稱：分組 id → 名稱；沒改過名的分組不在裡面。 */
  tabNames: Record<string, string>;
}

export type AppSettingsPatch = Partial<Pick<AppSettings, "retentionDays" | "runOrder" | "runSortModes" | "tabNames">>;

/** 排序字串的長度上限，擋掉異常大的寫入。 */
export const MAX_VIEW_PREF_CHARS = 100_000;

export const RETENTION_CHOICES: ReadonlyArray<{ days: number | null; label: string }> = [
  { days: 7, label: "7 天" },
  { days: 14, label: "14 天" },
  { days: 30, label: "30 天（預設）" },
  { days: 90, label: "90 天" },
  { days: 365, label: "一年" },
  { days: null, label: "永久保留" }
];

/** 單一類資料目前的用量；bytes 為 null 代表這個環境量不到佔用空間。 */
export interface DataCategoryUsage {
  count: number;
  bytes: number | null;
  /** 最早一筆的時間；沒有資料時為 null。 */
  oldestAt: number | null;
}

/** 「資料保留」會清理的三類資料用量，加上資料庫檔案大小與其中已清空、可重複利用的部分。 */
export interface DataUsage {
  events: DataCategoryUsage;
  logs: DataCategoryUsage;
  aiCalls: DataCategoryUsage;
  databaseBytes: number;
  freeBytes: number;
}

export interface BackupFileInfo {
  name: string;
  createdAt: number;
  bytes: number;
}

/** 設定頁的備份區：備份檔清單，加上每日自動備份的排程資訊（由主程序算好再傳）。 */
export interface BackupOverview {
  files: BackupFileInfo[];
  /** 下一次自動備份的時間（本地 22:00）。 */
  nextAutoBackupAt: number;
  /** 最多保留幾份，超過會自動刪掉最舊的。 */
  keep: number;
}

export interface RestoreSummary {
  settings: number;
  projects: number;
  branchRules: number;
  rules: number;
  terminalMappings: number;
}
