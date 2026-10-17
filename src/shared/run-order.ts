/** 專案啟動頁的手動排序：你在畫面上調整後固定下來的順序，疊在 run-groups.ts 的預設順序之上（純函式，不依賴 DOM／Node）。 */

import { findGitLiteProject, isIssueSkippedFolder, type IssueFeed } from "@shared/git-lite";
import { displayServiceName, groupRunServices, type RunServiceRow, type RunTargetView } from "@shared/run";
import { folderNameOf, orderRunServiceRows, targetsOfRunGroup, type RunGroupId } from "@shared/run-groups";

export interface RunOrder {
  /** 分組 id → 該頁籤內專案資料夾名稱（小寫）的順序。 */
  targets: Readonly<Record<string, readonly string[]>>;
  /** 專案資料夾名稱（小寫）→ 該專案內 App 名稱（小寫）的順序；手機合併列用去掉平台的 App 名稱。 */
  services: Readonly<Record<string, readonly string[]>>;
}

export const EMPTY_RUN_ORDER: RunOrder = { targets: {}, services: {} };

/** 編輯面板的一個專案；apps 是它底下的 App（服務列）。key 是存檔用的小寫名稱，label 是畫面文字。 */
export interface RunOrderEntry {
  key: string;
  label: string;
  apps: ReadonlyArray<{ key: string; label: string }>;
}

const MAX_LISTS = 200;
const MAX_KEYS = 200;
const MAX_KEY_LENGTH = 200;

/** 排序用的名稱一律小寫，和 run-groups.ts 的比對規則一致（不分大小寫）。 */
export const runOrderKey = (name: string): string => name.toLowerCase();

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOwn = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);

/** 只取自己的屬性：資料夾剛好叫 constructor、__proto__ 時不會誤拿到原型上的東西。 */
const listOf = (map: Readonly<Record<string, readonly string[]>>, key: string): readonly string[] | undefined =>
  hasOwn(map, key) && Array.isArray(map[key]) ? map[key] : undefined;

const parseKeys = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) return null;
  const keys: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item === "" || item.length > MAX_KEY_LENGTH) return null;
    if (!keys.includes(item)) keys.push(item);
  }
  return keys.length <= MAX_KEYS ? keys : null;
};

const parseLists = (value: unknown): Record<string, string[]> => {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, MAX_LISTS)
      .map(([name, keys]): [string, string[] | null] => [name, parseKeys(keys)])
      .filter((entry): entry is [string, string[]] => entry[1] !== null)
  );
};

/** 讀取時重新驗證：壞掉的 JSON 當作沒存過，壞掉的單一清單略過，其餘照用。 */
export const parseRunOrder = (stored: string | null | undefined): RunOrder => {
  if (typeof stored !== "string" || stored === "") return EMPTY_RUN_ORDER;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!isPlainObject(parsed)) return EMPTY_RUN_ORDER;
    return { targets: parseLists(parsed.targets), services: parseLists(parsed.services) };
  } catch {
    return EMPTY_RUN_ORDER;
  }
};

export const serializeRunOrder = (order: RunOrder): string => JSON.stringify({ targets: order.targets, services: order.services });

/**
 * 依已存的順序排列：在清單裡的依清單位置，沒列到的（例如新加的專案）接在後面並保持原順序。
 * 清單裡已經不存在的名稱直接忽略；沒有存過順序就原樣回傳。
 */
export const applySavedOrder = <T>(items: readonly T[], keyOf: (item: T) => string, saved: readonly string[] | undefined): T[] => {
  if (saved === undefined) return [...items];
  const positions = new Map(saved.map((key, index): [string, number] => [key, index]));
  const positionOf = (item: T): number => positions.get(keyOf(item)) ?? saved.length;
  return [...items].sort((a, b) => positionOf(a) - positionOf(b));
};

/** 把 index 位置的項目上移（delta -1）或下移（delta 1）一格；已在邊界或 index 無效就原樣回傳。 */
export const moveItem = <T>(items: readonly T[], index: number, delta: -1 | 1): T[] => {
  const next = [...items];
  const target = index + delta;
  if (!Number.isInteger(index) || index < 0 || index >= items.length || target < 0 || target >= items.length) return next;
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved as T);
  return next;
};

/** 服務列在順序表裡的名稱：手機合併列用 App 標題，一般服務用服務名稱。 */
export const serviceRowName = <T extends { name: string }>(row: RunServiceRow<T>): string => (row.kind === "mobile" ? row.title : row.service.name);

/** 頁籤內的專案：先套 run-groups.ts 的預設順序，再套已存的順序。 */
export const orderedRunTargets = <T extends { folder: string }>(targets: readonly T[], groupId: RunGroupId, order: RunOrder): T[] =>
  applySavedOrder(targetsOfRunGroup(targets, groupId), (target) => runOrderKey(folderNameOf(target.folder)), listOf(order.targets, groupId));

/** 專案內的服務列：先套 run-groups.ts 的預設順序，再套已存的順序。 */
export const orderedRunServiceRows = <T extends { name: string }>(folder: string, rows: ReadonlyArray<RunServiceRow<T>>, order: RunOrder): Array<RunServiceRow<T>> =>
  applySavedOrder(orderRunServiceRows(folder, rows), (row) => runOrderKey(serviceRowName(row)), listOf(order.services, runOrderKey(folderNameOf(folder))));

/** 把已經排好的專案轉成編輯面板的項目；專案順序照傳入的順序，App 依已存的順序。 */
export const entriesOfTargets = (targets: readonly RunTargetView[], order: RunOrder): RunOrderEntry[] =>
  targets.map((target) => ({
    key: runOrderKey(folderNameOf(target.folder)),
    label: target.label,
    apps: orderedRunServiceRows(target.folder, groupRunServices(target.services), order).map((row) => ({
      key: runOrderKey(serviceRowName(row)),
      label: displayServiceName(serviceRowName(row))
    }))
  }));

/** 編輯面板要顯示的專案與 App；傳 EMPTY_RUN_ORDER 就得到預設順序。 */
export const buildRunOrderEntries = (targets: readonly RunTargetView[], groupId: RunGroupId, order: RunOrder): RunOrderEntry[] =>
  entriesOfTargets(orderedRunTargets(targets, groupId, order), order);

const sameKeys = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((key, index) => key === b[index]);

const withList = (
  map: Readonly<Record<string, readonly string[]>>,
  name: string,
  keys: readonly string[],
  defaults: readonly string[]
): Record<string, readonly string[]> => {
  const rest = Object.fromEntries(Object.entries(map).filter(([existing]) => existing !== name));
  // 和預設一樣就不存，之後預設順序調整時才會跟著變。
  return sameKeys(keys, defaults) ? rest : { ...rest, [name]: keys };
};

/**
 * 把編輯後的順序合併進已存的順序：只改這個分組與它底下專案的清單，其他分組原封不動；和預設相同的清單會被移除。
 * projects 為 false 時只存 App 順序，專案順序維持原樣（專案正由 issue 數量自動排序時，畫面上的順序不是你的手動順序）。
 */
export const commitRunOrder = (
  order: RunOrder,
  groupId: RunGroupId,
  draft: readonly RunOrderEntry[],
  defaults: readonly RunOrderEntry[],
  options: { projects?: boolean } = {}
): RunOrder => {
  const targets =
    options.projects === false ? order.targets : withList(order.targets, groupId, draft.map((entry) => entry.key), defaults.map((entry) => entry.key));
  let services = order.services;
  for (const entry of draft) {
    const base = defaults.find((candidate) => candidate.key === entry.key);
    services = withList(services, entry.key, entry.apps.map((app) => app.key), (base?.apps ?? []).map((app) => app.key));
  }
  return { targets, services };
};

/* 排序模式：每個頁籤可以選「手動」（預設）或「issue 數量」；issue 數量排序疊在手動順序之上，同數量時沿用手動順序。 */

export type RunSortMode = "manual" | "issues";

/** 選了 issue 數量排序的頁籤（分組 id）；沒列到的頁籤就是手動。 */
export type RunSortModes = Readonly<Record<string, "issues">>;

export const EMPTY_RUN_SORT_MODES: RunSortModes = {};

/** 讀取時重新驗證：壞掉的 JSON 當作沒存過，只認得 "issues" 這個值。 */
export const parseRunSortModes = (stored: string | null | undefined): RunSortModes => {
  if (typeof stored !== "string" || stored === "") return EMPTY_RUN_SORT_MODES;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!isPlainObject(parsed)) return EMPTY_RUN_SORT_MODES;
    return Object.fromEntries(
      Object.entries(parsed)
        .slice(0, MAX_LISTS)
        .filter(([name, mode]) => name.length <= MAX_KEY_LENGTH && mode === "issues")
        .map(([name]): [string, "issues"] => [name, "issues"])
    );
  } catch {
    return EMPTY_RUN_SORT_MODES;
  }
};

export const serializeRunSortModes = (modes: RunSortModes): string => JSON.stringify(modes);

export const runSortModeOf = (modes: RunSortModes, groupId: RunGroupId): RunSortMode =>
  hasOwn(modes, groupId) && modes[groupId] === "issues" ? "issues" : "manual";

/** 設定某個頁籤的模式；回到手動就把記錄移除，不留多餘的資料。 */
export const withRunSortMode = (modes: RunSortModes, groupId: RunGroupId, mode: RunSortMode): RunSortModes => {
  const rest = Object.fromEntries(Object.entries(modes).filter(([name]) => name !== groupId));
  return mode === "issues" ? { ...rest, [groupId]: "issues" } : rest;
};

/** 專案目前的 open issue 數；讀不到（載入中、失敗、沒 token、沒有 repo、不讀 issue 的頁籤）回傳 null，和 0 筆區分。被截斷時只是下限。 */
export const openIssueCountOf = (feed: IssueFeed, folder: string): number | null => {
  if (feed.status !== "ready" || isIssueSkippedFolder(folder)) return null;
  const project = findGitLiteProject(feed.overview, folder);
  if (project === null || project.repo === null || project.issueErrorKind !== null) return null;
  return project.issues.length;
};

/** 依 open issue 數由多到少排；同數量維持傳入順序，讀不到的排最後。 */
export const sortByOpenIssues = <T extends { folder: string }>(targets: readonly T[], feed: IssueFeed): T[] => {
  const counts = new Map(targets.map((target): [T, number] => [target, openIssueCountOf(feed, target.folder) ?? -1]));
  return [...targets].sort((a, b) => (counts.get(b) ?? -1) - (counts.get(a) ?? -1));
};
