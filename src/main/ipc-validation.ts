import { EVENT_QUERY_MAX_LIMIT, type EventQuery } from "@shared/events";
import { validateDocumentShortcutInput, type DocumentShortcutInput } from "@shared/documents";
import type { LauncherSettingsPatch } from "@shared/ipc";
import { IPC, type IpcChannel } from "@shared/ipc";
import { LOG_CATEGORIES, LOG_LEVELS, LOG_QUERY_MAX_LIMIT, type LogQuery } from "@shared/logs";
import { validateProjectInput, type NormalizedProjectInput } from "@shared/projects";
import { RUN_PROJECT_ACTIONS, RUN_SERVICE_ACTIONS, isRunServiceName, isRunTargetId, normalizeRunAccount, type RunAction } from "@shared/run";
import { MAX_SECRET_LENGTH, isMaskedPlaceholder, isSecretName } from "@shared/secrets";
import type { StartWorkInput } from "@shared/start-work";

/**
 * 經由 IPC 進來的一切都是渲染層輸入，不因為渲染層是自己的程式就可信。
 * 這裡的驗證器全部 fail-closed：不認得的值回傳 null，呼叫端據此拒絕執行。
 */

const KNOWN_CHANNELS: ReadonlySet<string> = new Set<string>(Object.values(IPC));

export const isKnownChannel = (value: unknown): value is IpcChannel =>
  typeof value === "string" && KNOWN_CHANNELS.has(value);

// 任何字串入參的預設上限，避免失控的渲染層把超長字串送進驗證與資料庫。
export const MAX_IPC_STRING = 4096;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export interface BoundedStringOptions {
  max?: number;
  allowEmpty?: boolean;
  allowControl?: boolean;
}

export const asBoundedString = (value: unknown, options: BoundedStringOptions = {}): string | null => {
  const { max = MAX_IPC_STRING, allowEmpty = false, allowControl = false } = options;
  if (typeof value !== "string" || value.length > max) {
    return null;
  }
  if (!allowEmpty && value.length === 0) {
    return null;
  }
  if (!allowControl && CONTROL_CHARACTERS.test(value)) {
    return null;
  }
  return value;
};

export const asSafeInteger = (value: unknown, min: number, max: number): number | null => {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return null;
  }
  return value < min || value > max ? null : value;
};

export const asEnum = <T extends string>(value: unknown, allowed: readonly T[]): T | null =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;

// 不帶參數的通道：多帶任何東西都視為不合法輸入。
export const asNoArgs = (args: readonly unknown[]): [] | null => (args.length === 0 ? [] : null);

/** 秘密名稱必須是已知的固定名稱或符合規則的動態名稱。 */
export const asSecretName = (value: unknown): string | null => (isSecretName(value) ? value : null);

export type SecretValueInput = { kind: "value"; value: string } | { kind: "unchanged" };

/**
 * 渲染層送來的金鑰值：去頭尾空白（貼上常帶換行）、限長、不含控制字元。
 * 遮罩字串（UI 顯示用的「••••xxxx」）被原樣回送時視為「未變更」，不覆蓋已存的金鑰。
 */
export const asSecretValue = (value: unknown): SecretValueInput | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SECRET_LENGTH || CONTROL_CHARACTERS.test(trimmed)) {
    return null;
  }
  return isMaskedPlaceholder(trimmed) ? { kind: "unchanged" } : { kind: "value", value: trimmed };
};

export const asSecretNameArgs = (args: readonly unknown[]): [string] | null => {
  const name = args.length === 1 ? asSecretName(args[0]) : null;
  return name === null ? null : [name];
};

export const asSecretSetArgs = (args: readonly unknown[]): [string, SecretValueInput] | null => {
  if (args.length !== 2) {
    return null;
  }
  const name = asSecretName(args[0]);
  const input = asSecretValue(args[1]);
  return name === null || input === null ? null : [name, input];
};

const MAX_ID = 2_147_483_647;

export const asId = (value: unknown): number | null => asSafeInteger(value, 1, MAX_ID);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** 只接受清單內的鍵，多一個未知鍵就整個拒絕。 */
const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));

const MAX_FILTER_TEXT = 200;
const MAX_OFFSET = 10_000_000;

export const asEventQuery = (raw: unknown): EventQuery | null => {
  if (!isPlainObject(raw)) {
    return null;
  }
  if (!hasOnlyKeys(raw, ["projectId", "branch", "pusher", "fromMs", "toMs", "search", "branchViolationOnly", "limit", "offset"])) {
    return null;
  }

  const query: EventQuery = {};
  if (raw.projectId !== undefined) {
    const projectId = asId(raw.projectId);
    if (projectId === null) return null;
    query.projectId = projectId;
  }
  for (const key of ["branch", "pusher", "search"] as const) {
    if (raw[key] !== undefined) {
      const text = asBoundedString(raw[key], { max: MAX_FILTER_TEXT });
      if (text === null) return null;
      query[key] = text;
    }
  }
  for (const key of ["fromMs", "toMs"] as const) {
    if (raw[key] !== undefined) {
      const ms = asSafeInteger(raw[key], 0, Number.MAX_SAFE_INTEGER);
      if (ms === null) return null;
      query[key] = ms;
    }
  }
  if (raw.branchViolationOnly !== undefined) {
    if (typeof raw.branchViolationOnly !== "boolean") return null;
    query.branchViolationOnly = raw.branchViolationOnly;
  }
  if (raw.limit !== undefined) {
    const limit = asSafeInteger(raw.limit, 1, EVENT_QUERY_MAX_LIMIT);
    if (limit === null) return null;
    query.limit = limit;
  }
  if (raw.offset !== undefined) {
    const offset = asSafeInteger(raw.offset, 0, MAX_OFFSET);
    if (offset === null) return null;
    query.offset = offset;
  }
  return query;
};

export const asLogQuery = (raw: unknown): LogQuery | null => {
  if (!isPlainObject(raw)) {
    return null;
  }
  if (!hasOnlyKeys(raw, ["category", "level", "search", "fromMs", "toMs", "limit", "offset"])) {
    return null;
  }

  const query: LogQuery = {};
  if (raw.category !== undefined) {
    const category = asEnum(raw.category, LOG_CATEGORIES);
    if (category === null) return null;
    query.category = category;
  }
  if (raw.level !== undefined) {
    const level = asEnum(raw.level, LOG_LEVELS);
    if (level === null) return null;
    query.level = level;
  }
  if (raw.search !== undefined) {
    const search = asBoundedString(raw.search, { max: MAX_FILTER_TEXT });
    if (search === null) return null;
    query.search = search;
  }
  for (const key of ["fromMs", "toMs"] as const) {
    if (raw[key] !== undefined) {
      const ms = asSafeInteger(raw[key], 0, Number.MAX_SAFE_INTEGER);
      if (ms === null) return null;
      query[key] = ms;
    }
  }
  if (raw.limit !== undefined) {
    const limit = asSafeInteger(raw.limit, 1, LOG_QUERY_MAX_LIMIT);
    if (limit === null) return null;
    query.limit = limit;
  }
  if (raw.offset !== undefined) {
    const offset = asSafeInteger(raw.offset, 0, MAX_OFFSET);
    if (offset === null) return null;
    query.offset = offset;
  }
  return query;
};

export const asEventQueryArgs = (args: readonly unknown[]): [EventQuery] | null => {
  const query = args.length === 1 ? asEventQuery(args[0]) : null;
  return query === null ? null : [query];
};

export const asLogQueryArgs = (args: readonly unknown[]): [LogQuery] | null => {
  const query = args.length === 1 ? asLogQuery(args[0]) : null;
  return query === null ? null : [query];
};

export const asIdArgs = (args: readonly unknown[]): [number] | null => {
  const id = args.length === 1 ? asId(args[0]) : null;
  return id === null ? null : [id];
};

/** 文件捷徑 id：手動保存的為正數，自動發現的專案 README 為負數；0 不是有效 id。 */
export const asDocumentOpenArgs = (args: readonly unknown[]): [number] | null => {
  const id = args.length === 1 ? asSafeInteger(args[0], -MAX_ID, MAX_ID) : null;
  return id === null || id === 0 ? null : [id];
};

export const asBooleanArgs = (args: readonly unknown[]): [boolean] | null =>
  args.length === 1 && typeof args[0] === "boolean" ? [args[0]] : null;

/** 0 = 全域預設，其他 = 專案 id。 */
export const asScopeId = (value: unknown): number | null => asSafeInteger(value, 0, MAX_ID);

export const asScopeIdArgs = (args: readonly unknown[]): [number] | null => {
  const id = args.length === 1 ? asScopeId(args[0]) : null;
  return id === null ? null : [id];
};

/** 規則內容的細部驗證與錯誤訊息由處理器負責（要回報給使用者），這裡只確認形狀。 */
export const asBranchRuleSaveArgs = (args: readonly unknown[]): [number, Record<string, unknown>] | null => {
  if (args.length !== 2) {
    return null;
  }
  const scopeId = asScopeId(args[0]);
  return scopeId === null || !isPlainObject(args[1]) ? null : [scopeId, args[1]];
};

export const asStartWorkInput = (raw: unknown): StartWorkInput | null => {
  if (!isPlainObject(raw) || !hasOnlyKeys(raw, ["type", "slug"])) {
    return null;
  }
  const input: StartWorkInput = {};
  if (raw.type !== undefined) {
    const type = asBoundedString(raw.type, { max: 12, allowEmpty: true });
    if (type === null) return null;
    input.type = type;
  }
  if (raw.slug !== undefined) {
    const slug = asBoundedString(raw.slug, { max: MAX_FILTER_TEXT, allowEmpty: true });
    if (slug === null) return null;
    input.slug = slug;
  }
  return input;
};

export const asStartWorkPreviewArgs = (args: readonly unknown[]): [number, StartWorkInput] | null => {
  if (args.length !== 2) {
    return null;
  }
  const id = asId(args[0]);
  const input = asStartWorkInput(args[1]);
  return id === null || input === null ? null : [id, input];
};

export const asStartWorkRunArgs = (args: readonly unknown[]): [number, StartWorkInput, string] | null => {
  if (args.length !== 3) {
    return null;
  }
  const id = asId(args[0]);
  const input = asStartWorkInput(args[1]);
  const expected = asBoundedString(args[2], { max: 255 });
  return id === null || input === null || expected === null ? null : [id, input, expected];
};

/** 規則內容的細部驗證與錯誤訊息由處理器負責（要回報給使用者），這裡只確認形狀。 */
export const asRuleObjectArgs = (args: readonly unknown[]): [Record<string, unknown>] | null =>
  args.length === 1 && isPlainObject(args[0]) ? [args[0]] : null;

export const asRuleUpdateArgs = (args: readonly unknown[]): [number, Record<string, unknown>] | null => {
  if (args.length !== 2) {
    return null;
  }
  const id = asId(args[0]);
  return id === null || !isPlainObject(args[1]) ? null : [id, args[1]];
};

export const asRuleEnabledArgs = (args: readonly unknown[]): [number, boolean] | null => {
  const id = args.length === 2 ? asId(args[0]) : null;
  return id === null || typeof args[1] !== "boolean" ? null : [id, args[1]];
};

const MAX_REORDER = 500;

export const asReorderArgs = (args: readonly unknown[]): [number[]] | null => {
  const list = args[0];
  if (args.length !== 1 || !Array.isArray(list) || list.length > MAX_REORDER) {
    return null;
  }
  const ids = list.map(asId);
  return ids.every((id): id is number => id !== null) ? [ids] : null;
};

export const asRuleDryRunArgs = (args: readonly unknown[]): [Record<string, unknown>, number] | null => {
  if (args.length !== 2 || !isPlainObject(args[0])) {
    return null;
  }
  const eventId = asId(args[1]);
  return eventId === null ? null : [args[0], eventId];
};

/** 0 或 1 個 id：沒給就是 undefined（不篩選）。 */
export const asOptionalIdArgs = (args: readonly unknown[]): [number | undefined] | null => {
  if (args.length === 0) {
    return [undefined];
  }
  const id = args.length === 1 ? asId(args[0]) : null;
  return id === null ? null : [id];
};

/** 要開啟的資料夾路徑：有長度與字元限制；是不是真的存在、是不是資料夾由啟動流程檢查。 */
export const asFolderPathArgs = (args: readonly unknown[]): [string] | null => {
  const path = args.length === 1 ? asBoundedString(args[0], { max: 4096 }) : null;
  return path === null ? null : [path];
};

/** 專案啟動頁的目標識別（p:數字／f:數字）與動作名稱；其他一律拒絕。 */
export const asRunActionArgs = (args: readonly unknown[]): [string, RunAction] | null => {
  if (args.length !== 2 || !isRunTargetId(args[0])) {
    return null;
  }
  const raw = args[1];
  if (!isPlainObject(raw)) {
    return null;
  }
  if (raw.scope === "project") {
    if (!hasOnlyKeys(raw, ["scope", "action"])) return null;
    const action = asEnum(raw.action, RUN_PROJECT_ACTIONS);
    return action === null ? null : [args[0], { scope: "project", action }];
  }
  if (raw.scope === "service") {
    if (!hasOnlyKeys(raw, ["scope", "service", "action"]) || !isRunServiceName(raw.service)) return null;
    const action = asEnum(raw.action, RUN_SERVICE_ACTIONS);
    return action === null ? null : [args[0], { scope: "service", service: raw.service, action }];
  }
  return null;
};

export const asRunTargetIdArgs = (args: readonly unknown[]): [string] | null =>
  args.length === 1 && isRunTargetId(args[0]) ? [args[0]] : null;

/** 目標識別加 dev 通關帳號；帳號去頭尾空白，空字串合法（代表清除）。 */
export const asRunAccountArgs = (args: readonly unknown[]): [string, string] | null => {
  if (args.length !== 2 || !isRunTargetId(args[0])) {
    return null;
  }
  const account = normalizeRunAccount(args[1]);
  return account === null ? null : [args[0], account];
};

/** 專案根目錄：空字串代表關閉自動掃描；是否為存在的資料夾由處理器檢查。 */
export const asDocumentRootArgs = (args: readonly unknown[]): [string] | null => {
  const path = args.length === 1 ? asBoundedString(args[0], { allowEmpty: true }) : null;
  return path === null ? null : [path.trim()];
};

export const asDocumentShortcutArgs =(args: readonly unknown[]): [DocumentShortcutInput] | null => {
  if (args.length !== 1 || !isPlainObject(args[0])) {
    return null;
  }
  const result = validateDocumentShortcutInput(args[0]);
  return result.ok ? [result.value] : null;
};

export const asLauncherSettingsPatch = (raw: unknown): LauncherSettingsPatch | null => {
  if (!isPlainObject(raw) || !hasOnlyKeys(raw, ["shortcut", "defaultTerminal", "selectedProjectId"])) {
    return null;
  }
  const patch: LauncherSettingsPatch = {};
  if (raw.shortcut !== undefined) {
    if (raw.shortcut === null) {
      patch.shortcut = null;
    } else {
      const shortcut = asBoundedString(raw.shortcut, { max: 60 });
      if (shortcut === null) return null;
      patch.shortcut = shortcut;
    }
  }
  if (raw.defaultTerminal !== undefined) {
    const terminal = asBoundedString(raw.defaultTerminal, { max: 60 });
    if (terminal === null) return null;
    patch.defaultTerminal = terminal;
  }
  if (raw.selectedProjectId !== undefined) {
    if (raw.selectedProjectId === null) {
      patch.selectedProjectId = null;
    } else {
      const id = asId(raw.selectedProjectId);
      if (id === null) return null;
      patch.selectedProjectId = id;
    }
  }
  return patch;
};

export const asLauncherSettingsArgs = (args: readonly unknown[]): [LauncherSettingsPatch] | null => {
  const patch = args.length === 1 ? asLauncherSettingsPatch(args[0]) : null;
  return patch === null ? null : [patch];
};

/** 讓使用者複製 AI 產生的 commit 訊息：長度有上限、不含控制字元（一行文字）。 */
export const asClipboardArgs = (args: readonly unknown[]): [string] | null => {
  const text = args.length === 1 ? asBoundedString(args[0], { max: 500 }) : null;
  return text === null ? null : [text];
};

const EXTERNAL_LINK_HOST = "github.com";
const EXTERNAL_LINK_PATH_PREFIX = "/settings/";

/**
 * 可由渲染層要求用系統瀏覽器開啟的網址：只收 https://github.com/settings/ 底下的頁面。
 * 先交給 URL 解析再比對（../、反斜線、帳密、埠號等繞法都會在解析後現形），回傳正規化後的網址。
 */
export const asExternalUrl = (value: unknown): string | null => {
  const text = asBoundedString(value, { max: 300 });
  if (text === null) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== EXTERNAL_LINK_HOST || url.port !== "" || url.username !== "" || url.password !== "") {
    return null;
  }
  return url.pathname.startsWith(EXTERNAL_LINK_PATH_PREFIX) ? url.href : null;
};

export const asExternalLinkArgs = (args: readonly unknown[]): [string] | null => {
  const url = args.length === 1 ? asExternalUrl(args[0]) : null;
  return url === null ? null : [url];
};

/** 預測衝突：專案 id，加上可選的比對分支名稱（是否為合法分支名稱由服務檢查）。 */
export const asConflictArgs = (args: readonly unknown[]): [number, string | undefined] | null => {
  if (args.length === 0 || args.length > 2) return null;
  const id = asId(args[0]);
  if (id === null) return null;
  if (args[1] === undefined) return [id, undefined];
  const against = asBoundedString(args[1], { max: 255 });
  return against === null ? null : [id, against];
};

/** 一般設定：只確認形狀與允許的鍵，值的細部檢查與錯誤訊息由處理器負責。 */
export const asAppSettingsArgs = (args: readonly unknown[]): [Record<string, unknown>] | null => {
  const raw = args[0];
  if (args.length !== 1 || !isPlainObject(raw) || !hasOnlyKeys(raw, ["retentionDays"])) {
    return null;
  }
  return [raw];
};

/** 備份檔名：只收本程式產生的格式，其他一律拒絕（完整檢查在還原時再做一次）。 */
export const asBackupNameArgs = (args: readonly unknown[]): [string] | null => {
  const name = args.length === 1 ? asBoundedString(args[0], { max: 100 }) : null;
  return name !== null && /^config-\d{8}-\d{6}-\d{3}\.json$/.test(name) ? [name] : null;
};

/** 新增專案：完整驗證後的正規化輸入。 */
export const asProjectInputArgs = (args: readonly unknown[]): [NormalizedProjectInput] | null => {
  if (args.length !== 1 || !isPlainObject(args[0])) {
    return null;
  }
  const result = validateProjectInput(args[0]);
  return result.ok ? [result.value] : null;
};

const PATCHABLE_PROJECT_KEYS = ["name", "localPath", "branchFilter", "pollIntervalSec", "mode", "enabled", "aiEnabled"] as const;

/** 更新專案：只接受可變更的欄位；owner／repo 一律不收。細部驗證在合併後進行。 */
export const asProjectUpdateArgs = (args: readonly unknown[]): [number, Record<string, unknown>] | null => {
  if (args.length !== 2) {
    return null;
  }
  const id = asId(args[0]);
  const patch = args[1];
  if (id === null || !isPlainObject(patch) || !hasOnlyKeys(patch, PATCHABLE_PROJECT_KEYS)) {
    return null;
  }
  return [id, patch];
};

export type ArgsValidator<A extends unknown[]> = (args: readonly unknown[]) => A | null;

export class InvalidIpcInputError extends Error {
  constructor() {
    super("ipc: invalid input");
    this.name = "InvalidIpcInputError";
  }
}

/** 先驗證再執行；驗證失敗直接拒絕，handler 不會被呼叫。 */
export const runValidated = async <A extends unknown[], R>(
  validate: ArgsValidator<A>,
  rawArgs: readonly unknown[],
  handler: (...args: A) => R | Promise<R>
): Promise<R> => {
  const args = validate(rawArgs);
  if (args === null) {
    throw new InvalidIpcInputError();
  }
  return handler(...args);
};
