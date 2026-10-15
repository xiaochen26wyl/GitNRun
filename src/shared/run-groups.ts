/** 專案啟動頁的分組：依專案資料夾名稱把專案分到固定的幾個頁籤（純函式，不依賴 DOM／Node）。 */

export type RunGroupId = "open-source" | "saas" | "creator" | "personal" | "someday" | "other";

export interface RunGroup {
  id: RunGroupId;
  label: string;
  /** 屬於這組的資料夾名稱（資料夾路徑最後一段，不分大小寫）。 */
  folders: readonly string[];
}

/** 頁籤順序即陣列順序。改分組只需要改這裡。 */
export const RUN_GROUPS: readonly RunGroup[] = [
  { id: "open-source", label: "開源Free", folders: ["Usage-Pulse"] },
  { id: "saas", label: "SAAS", folders: ["stockPaw", "toBloom", "xiaochenStudio"] },
  { id: "creator", label: "創作者宇宙", folders: ["MahoPurr-Catalyst", "fictionPurr", "translationService"] },
  { id: "personal", label: "自己用", folders: ["GitNRun", "socialHub"] },
  { id: "someday", label: "不知道什麼時候才完成", folders: ["yumeAegis"] }
];

/** 對不到任何一組的專案；只在真的有這種專案時才會出現成頁籤。 */
export const RUN_OTHER_GROUP: RunGroup = { id: "other", label: "其他", folders: [] };

export const DEFAULT_RUN_GROUP_ID: RunGroupId = "open-source";

const GROUP_OF_FOLDER_NAME: ReadonlyMap<string, RunGroupId> = new Map(
  RUN_GROUPS.flatMap((group) => group.folders.map((name): [string, RunGroupId] => [name.toLowerCase(), group.id]))
);

export const runGroupById = (id: RunGroupId): RunGroup => RUN_GROUPS.find((group) => group.id === id) ?? RUN_OTHER_GROUP;

/** 資料夾路徑的最後一段；尾端斜線略過，空路徑回傳空字串。 */
export const folderNameOf = (folder: string): string => {
  const segments = folder.split("/").filter((segment) => segment !== "");
  return segments[segments.length - 1] ?? "";
};

export const runGroupIdOf = (folder: string): RunGroupId => GROUP_OF_FOLDER_NAME.get(folderNameOf(folder).toLowerCase()) ?? "other";

export const targetsOfRunGroup = <T extends { folder: string }>(targets: readonly T[], id: RunGroupId): T[] =>
  targets.filter((target) => runGroupIdOf(target.folder) === id);

export const countUngroupedRunTargets = (targets: ReadonlyArray<{ folder: string }>): number => targetsOfRunGroup(targets, "other").length;
