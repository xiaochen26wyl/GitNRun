import type { ChangedFile, PushEvent } from "@shared/events";

/**
 * 沒有 AI 可用時的本機備用方案（沒網路、額度用完、專案沒開啟、金鑰沒設定）。
 * 只依檔案路徑與數量推斷，不讀內容；推斷不出來就說得保守，不假裝懂。
 */

const DOC = /(^|\/)(docs?|documentation)\/|\.(md|mdx|rst|txt)$/i;
const TEST = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z0-9]+$/i;
const STYLE = /\.(css|scss|sass|less|styl)$/i;
const CONFIG = /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|tsconfig[^/]*\.json|\.github\/|\.gitignore|\.editorconfig|Dockerfile|docker-compose[^/]*\.ya?ml)$|\.config\.[a-z]+$|\.lock$/i;

export type CommitType = "feat" | "fix" | "chore" | "docs" | "refactor" | "style" | "test";

const allMatch = (files: readonly ChangedFile[], pattern: RegExp): boolean => files.length > 0 && files.every((file) => pattern.test(file.path));

export const inferCommitType = (files: readonly ChangedFile[]): CommitType => {
  if (allMatch(files, DOC)) return "docs";
  if (allMatch(files, TEST)) return "test";
  if (allMatch(files, STYLE)) return "style";
  if (allMatch(files, CONFIG)) return "chore";
  const added = files.filter((file) => file.status === "added").length;
  // 有新增檔案才有把握說是新功能；其餘不猜是修正還是重構，用中性的 chore。
  return added > 0 && files.every((file) => file.status !== "removed") ? "feat" : "chore";
};

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const VERB: Record<ChangedFile["status"], string> = { added: "新增", modified: "修改", removed: "刪除", renamed: "更名" };

/** 本機推斷的 commit 訊息：`<type>: 一句繁體中文`。 */
export const offlineCommitMessage = (files: readonly ChangedFile[]): string => {
  if (files.length === 0) {
    return "chore: 更新專案";
  }
  const type = inferCommitType(files);
  const first = files[0] as ChangedFile;
  if (files.length === 1) {
    return `${type}: ${VERB[first.status]} ${baseName(first.path)}`;
  }
  const statuses = new Set(files.map((file) => file.status));
  const verb = statuses.size === 1 ? VERB[first.status] : "更新";
  return `${type}: ${verb} ${baseName(first.path)} 等 ${files.length} 個檔案`;
};

const countBy = (files: readonly ChangedFile[], status: ChangedFile["status"]): number => files.filter((file) => file.status === status).length;

/** 事件摘要（不需要 AI）：誰、推了什麼、改了多少。 */
export const offlineSummary = (event: Pick<PushEvent, "pusher" | "pusherInferred" | "branch" | "eventType" | "headMessage" | "commits" | "files" | "fileCount">): string => {
  if (event.eventType === "delete") {
    return `分支 ${event.branch} 已被刪除。`;
  }
  const who = event.pusher ? `${event.pusher}${event.pusherInferred ? "（推定）" : ""}` : "有人";
  const created = event.eventType === "create" ? "建立了新分支並推送" : "推送";
  const commits = event.commits.length > 0 ? `${event.commits.length} 個 commit 到` : "到";
  const stat =
    event.files.length > 0
      ? `，變更 ${event.fileCount} 個檔案（新增 ${countBy(event.files, "added")}、修改 ${countBy(event.files, "modified")}、刪除 ${countBy(event.files, "removed")}）`
      : "";
  const message = event.headMessage ? `：${event.headMessage}` : "";
  return `${who}${created}${commits} ${event.branch}${stat}${message}`;
};

const RISKY = /(^|\/)(\.github\/|Dockerfile|docker-compose|\.env|.*\.(pem|key)$|package\.json$|pnpm-lock\.yaml$|migrations?\/)/i;

/** 本機規則的推送建議：列出需要多看一眼的地方，不下「可以合併」的結論。 */
export const offlineSuggestion = (
  event: Pick<PushEvent, "branch" | "branchViolation" | "fileCount" | "files" | "eventType">
): string => {
  if (event.eventType === "delete") {
    return "分支已刪除，沒有需要檢查的變更。";
  }
  const notes: string[] = [];
  if (event.branchViolation) notes.push("分支名稱不符合命名規則，建議確認是否要改名。");
  if (event.fileCount >= 30) notes.push(`一次變更 ${event.fileCount} 個檔案，建議拆成較小的推送或逐一審查。`);
  const risky = event.files.filter((file) => RISKY.test(file.path)).map((file) => file.path);
  if (risky.length > 0) notes.push(`包含設定、部署或依賴相關檔案，請特別確認：${risky.slice(0, 5).join("、")}${risky.length > 5 ? " 等" : ""}。`);
  if (event.files.length > 0 && event.files.every((file) => TEST.test(file.path))) notes.push("只有測試檔案變更。");
  if (notes.length === 0) notes.push("沒有發現需要特別注意的地方（本機規則只看檔案路徑與數量，不看內容）。");
  return notes.map((note) => `• ${note}`).join("\n");
};
