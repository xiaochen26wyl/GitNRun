/** 每日自動備份的時間計算（純函式，不碰計時器與檔案；一律用本地時區）。 */

export const DAILY_BACKUP_HOUR = 22;

/** 指定日期（本地）的 22:00。 */
const slotOf = (date: Date): number =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate(), DAILY_BACKUP_HOUR, 0, 0, 0).getTime();

/** 下一個 22:00（嚴格晚於 now）：今天還沒到就是今天，已到或已過就是明天。 */
export const nextBackupAt = (now: number): number => {
  const today = slotOf(new Date(now));
  if (today > now) {
    return today;
  }
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return slotOf(tomorrow);
};

/** 最近一次已經過去（含剛好等於 now）的 22:00。 */
export const lastBackupSlot = (now: number): number => {
  const today = slotOf(new Date(now));
  if (today <= now) {
    return today;
  }
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return slotOf(yesterday);
};

/** 最新備份早於最近一個 22:00 就要補（沒有任何備份也要補）。 */
export const isBackupOverdue = (now: number, latestBackupAt: number | null): boolean =>
  latestBackupAt === null || latestBackupAt < lastBackupSlot(now);
