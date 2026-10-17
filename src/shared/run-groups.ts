/** 專案啟動頁的分組與排序：依專案資料夾名稱把專案分到固定的幾個頁籤，並決定頁籤內專案與專案內服務列的順序（純函式，不依賴 DOM／Node）。 */

import type { RunServiceRow } from "@shared/run";

export type RunGroupId = "open-source" | "saas" | "creator" | "personal" | "someday" | "other";

export interface RunGroup {
  id: RunGroupId;
  label: string;
  /** 屬於這組的資料夾名稱（資料夾路徑最後一段，不分大小寫）。 */
  folders: readonly string[];
}

/** 頁籤順序即陣列順序；每組的 folders 順序就是該頁籤內專案的顯示順序。改分組與排序只需要改這裡。 */
export const RUN_GROUPS: readonly RunGroup[] = [
  { id: "open-source", label: "開源Free", folders: ["Usage-Pulse"] },
  { id: "saas", label: "SAAS", folders: ["stockPaw", "toBloom", "xiaochenStudio"] },
  { id: "creator", label: "創作者宇宙", folders: ["fictionPurr", "translationService", "MahoPurr-Catalyst"] },
  { id: "personal", label: "自己用", folders: ["GitNRun", "socialHub"] },
  { id: "someday", label: "遊戲需要美術", folders: ["yumeAegis"] }
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

/** 名稱在順序表中的位置（不分大小寫）；不在表內的排在所有已列名稱之後，彼此保持原順序（Array.sort 是穩定排序）。 */
const positionIn = (names: readonly string[]): ((name: string) => number) => {
  const positions = new Map(names.map((name, index): [string, number] => [name.toLowerCase(), index]));
  return (name) => positions.get(name.toLowerCase()) ?? names.length;
};

/** 屬於該分組的專案，依分組表 folders 的順序排列，不受資料庫或資料夾掃描順序影響；「其他」沒有順序表，維持傳入順序。 */
export const targetsOfRunGroup = <T extends { folder: string }>(targets: readonly T[], id: RunGroupId): T[] => {
  const position = positionIn(runGroupById(id).folders);
  return targets
    .filter((target) => runGroupIdOf(target.folder) === id)
    .sort((a, b) => position(folderNameOf(a.folder)) - position(folderNameOf(b.folder)));
};

/**
 * 專案內服務列的顯示順序：key 是專案資料夾名稱（小寫），值依序是服務名稱（一般服務）或手機 app 名稱（手機合併列）。
 * 同層級（並排、並行）的服務相鄰排列。只影響畫面順序，不影響啟動順序。
 */
const SERVICE_ORDER: ReadonlyMap<string, readonly string[]> = new Map([
  [
    "fictionpurr",
    [
      "api",
      "desktop-mahopurr",
      "mobile-mahopurr",
      "web-sparkpurr",
      "mobile-fictionpurr",
      "web-fictionpurr",
      "mobile-anipurr",
      "mobile-poppurr"
    ]
  ]
]);

/** 服務列依專案的順序表排序；表裡沒列到的服務接在後面並保持原順序，沒有順序表的專案維持原樣。 */
export const orderRunServiceRows = <T extends { name: string }>(folder: string, rows: ReadonlyArray<RunServiceRow<T>>): Array<RunServiceRow<T>> => {
  const names = SERVICE_ORDER.get(folderNameOf(folder).toLowerCase());
  if (names === undefined) {
    return [...rows];
  }
  const position = positionIn(names);
  const keyOf = (row: RunServiceRow<T>): string => (row.kind === "mobile" ? row.title : row.service.name);
  return [...rows].sort((a, b) => position(keyOf(a)) - position(keyOf(b)));
};

export const countUngroupedRunTargets = (targets: ReadonlyArray<{ folder: string }>): number => targetsOfRunGroup(targets, "other").length;
