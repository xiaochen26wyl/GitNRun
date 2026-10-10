/** 專案（被監視的 GitHub repo）的共用型別與輸入驗證（純函式，渲染層表單也用）。 */

export type ProjectMode = "poll" | "webhook" | "both";
export const PROJECT_MODES: readonly ProjectMode[] = ["poll", "webhook", "both"];

export const MIN_POLL_INTERVAL_SEC = 15;
export const MAX_POLL_INTERVAL_SEC = 3600;
export const DEFAULT_POLL_INTERVAL_SEC = 30;

export interface Project {
  id: number;
  name: string;
  owner: string;
  repo: string;
  localPath: string | null;
  defaultBranch: string | null;
  branchFilter: string[];
  pollIntervalSec: number;
  mode: ProjectMode;
  aiEnabled: boolean;
  enabled: boolean;
  createdAt: number;
}

export interface ProjectInput {
  owner: string;
  repo: string;
  name?: string;
  localPath?: string | null;
  branchFilter?: string[];
  pollIntervalSec?: number;
  mode?: ProjectMode;
  enabled?: boolean;
  /** 是否允許把這個專案的內容（差異、commit 訊息）送給 AI 分析；預設關閉。 */
  aiEnabled?: boolean;
}

export type NormalizedProjectInput = Required<Omit<ProjectInput, "localPath">> & { localPath: string | null };

/** GitHub 使用者／組織／repo 名稱允許的字元；禁止 "." 與 ".." 以免組出路徑穿越。 */
export const REPO_PART_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
export const isRepoPart = (value: unknown): value is string =>
  typeof value === "string" && REPO_PART_PATTERN.test(value) && value !== "." && value !== "..";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MAX_FILTERS = 50;
const MAX_FILTER_LENGTH = 200;

export type ProjectValidation =
  | { ok: true; value: NormalizedProjectInput }
  | { ok: false; errors: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const validateProjectInput = (raw: unknown): ProjectValidation => {
  const errors: string[] = [];
  if (!isRecord(raw)) {
    return { ok: false, errors: ["輸入格式不正確"] };
  }

  const owner = typeof raw.owner === "string" ? raw.owner.trim() : "";
  const repo = typeof raw.repo === "string" ? raw.repo.trim() : "";
  if (!isRepoPart(owner)) {
    errors.push("擁有者名稱不正確");
  }
  if (!isRepoPart(repo)) {
    errors.push("Repo 名稱不正確");
  }

  const name = raw.name === undefined ? `${owner}/${repo}` : typeof raw.name === "string" ? raw.name.trim() : "";
  if (name.length === 0 || name.length > 200 || CONTROL_CHARACTERS.test(name)) {
    errors.push("專案名稱不正確");
  }

  let localPath: string | null = null;
  if (raw.localPath !== undefined && raw.localPath !== null) {
    if (
      typeof raw.localPath !== "string" ||
      raw.localPath.length === 0 ||
      raw.localPath.length > 4096 ||
      CONTROL_CHARACTERS.test(raw.localPath) ||
      !raw.localPath.startsWith("/")
    ) {
      errors.push("本機路徑必須是絕對路徑");
    } else {
      localPath = raw.localPath;
    }
  }

  let branchFilter: string[] = ["*"];
  if (raw.branchFilter !== undefined) {
    if (
      !Array.isArray(raw.branchFilter) ||
      raw.branchFilter.length === 0 ||
      raw.branchFilter.length > MAX_FILTERS ||
      raw.branchFilter.some(
        (item) =>
          typeof item !== "string" ||
          item.trim().length === 0 ||
          item.length > MAX_FILTER_LENGTH ||
          CONTROL_CHARACTERS.test(item)
      )
    ) {
      errors.push("分支篩選不正確");
    } else {
      branchFilter = (raw.branchFilter as string[]).map((item) => item.trim());
    }
  }

  let pollIntervalSec = DEFAULT_POLL_INTERVAL_SEC;
  if (raw.pollIntervalSec !== undefined) {
    if (
      typeof raw.pollIntervalSec !== "number" ||
      !Number.isSafeInteger(raw.pollIntervalSec) ||
      raw.pollIntervalSec < MIN_POLL_INTERVAL_SEC ||
      raw.pollIntervalSec > MAX_POLL_INTERVAL_SEC
    ) {
      errors.push(`輪詢間隔需介於 ${MIN_POLL_INTERVAL_SEC} 到 ${MAX_POLL_INTERVAL_SEC} 秒`);
    } else {
      pollIntervalSec = raw.pollIntervalSec;
    }
  }

  let mode: ProjectMode = "poll";
  if (raw.mode !== undefined) {
    const candidate = PROJECT_MODES.find((item) => item === raw.mode);
    if (candidate) {
      mode = candidate;
    } else {
      errors.push("監視模式不正確");
    }
  }

  let enabled = true;
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === "boolean") {
      enabled = raw.enabled;
    } else {
      errors.push("啟用狀態不正確");
    }
  }

  let aiEnabled = false;
  if (raw.aiEnabled !== undefined) {
    if (typeof raw.aiEnabled === "boolean") {
      aiEnabled = raw.aiEnabled;
    } else {
      errors.push("AI 開關不正確");
    }
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: { owner, repo, name, localPath, branchFilter, pollIntervalSec, mode, enabled, aiEnabled } };
};
