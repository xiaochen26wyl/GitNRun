import { isValidBranchName } from "@shared/branch-template";
import type { PushEvent } from "@shared/events";
import { normalizeCommitMessage } from "@main/ai/prompts";

/**
 * 規則裡 git 動作的參數：先代入事件變數，再整體檢查。
 *
 * - 只有 {branch}、{sha}、{before_sha}、{ai_commit_message} 四個變數；代入的值必須通過驗證（分支名稱要是合法的
 *   git 分支名稱），而且代入後不能讓原本不是選項的參數變成選項（以 "-" 開頭）。
 * - 會執行外部程式或寫入任意檔案的長選項一律拒絕；ext::／fd:: 傳輸則由 GIT_ALLOW_PROTOCOL 在
 *   git 本身擋下。短選項（-c、-C 等）因為子指令固定放在最前面，不可能被當成 git 的全域選項，
 *   而且 `git commit -C <commit>` 之類是正常用法，所以不擋。
 */

const MAX_ARG_LENGTH = 500;
const SHA_PATTERN = /^[0-9a-f]{40,64}$/i;
const PLACEHOLDER = /\{(branch|sha|before_sha|ai_commit_message)\}/g;

const FORBIDDEN_OPTION = /^--(upload-pack|receive-pack|exec|exec-path|git-dir|work-tree|namespace|config|config-env|super-prefix|ext-cmd|output|open-files-in-pager)(=|$)/i;
const EXTERNAL_TRANSPORT = /^(ext|fd)::/i;

export type GitArgsResult = { ok: true; args: string[] } | { ok: false; message: string };

type EventRefs = Pick<PushEvent, "branch" | "afterSha" | "beforeSha">;

const valueFor = (name: string, event: EventRefs, variables: Readonly<Record<string, string>>): string | null => {
  switch (name) {
    case "ai_commit_message": {
      // 就算是我們自己產生的，也再驗證一次：必須是一行合規的 commit 訊息。
      const message = variables.ai_commit_message;
      return message !== undefined && normalizeCommitMessage(message) === message ? message : null;
    }
    case "branch":
      return isValidBranchName(event.branch) ? event.branch : null;
    case "sha":
      return SHA_PATTERN.test(event.afterSha) ? event.afterSha : null;
    case "before_sha":
      return event.beforeSha !== null && SHA_PATTERN.test(event.beforeSha) ? event.beforeSha : null;
    default:
      return null;
  }
};

export const expandGitArgs = (
  templateArgs: readonly string[],
  event: EventRefs,
  variables: Readonly<Record<string, string>> = {}
): GitArgsResult => {
  const args: string[] = [];

  for (const template of templateArgs) {
    let failed: string | null = null;
    const expanded = template.replace(PLACEHOLDER, (_whole, name: string) => {
      const value = valueFor(name, event, variables);
      if (value === null) {
        failed =
          name === "ai_commit_message"
            ? "還沒有可用的 AI commit 訊息；請在前面加上「生成 AI commit 訊息」動作"
            : `事件的 ${name} 不合法，不會代入 git 參數`;
        return "";
      }
      return value;
    });
    if (failed) {
      return { ok: false, message: failed };
    }
    if (expanded.length === 0 || expanded.length > MAX_ARG_LENGTH || expanded.includes("\0") || expanded.includes("\n")) {
      return { ok: false, message: "git 參數不可為空、過長，或含有換行" };
    }
    // 事件的值不能把一般參數變成選項。
    if (expanded.startsWith("-") && !template.startsWith("-")) {
      return { ok: false, message: "代入事件內容後參數會變成選項，已拒絕" };
    }
    if (FORBIDDEN_OPTION.test(expanded)) {
      return { ok: false, message: `不允許的 git 選項：${expanded.split("=")[0]}` };
    }
    if (EXTERNAL_TRANSPORT.test(expanded)) {
      return { ok: false, message: "不允許外部程式傳輸（ext::／fd::）" };
    }
    args.push(expanded);
  }
  return { ok: true, args };
};
