import {
  TYPE_PATTERN,
  TemplateRenderError,
  dateValues,
  isValidBranchName,
  normalizeVersion,
  parseTemplate,
  renderBranchName,
  sanitizeSlug,
  templateTokens,
  type BranchValues
} from "@shared/branch-template";
import type { Project } from "@shared/projects";
import type {
  StartWorkBlockReason,
  StartWorkInput,
  StartWorkPlan,
  StartWorkPreview,
  StartWorkResult,
  StepReport
} from "@shared/start-work";
import type { StoredBranchRule } from "@main/db/branch-rules-repo";
import type { GitRunner } from "@main/git/run-git";
import { redactSecrets } from "@main/log-redaction";

/**
 * 「開工」：依分支命名規則建立並推送新分支。
 *
 * 流程沿用既有慣例：工作區有未提交異動就回報並停止 → fetch → 切到預設分支並只做
 * fast-forward 的 pull → 建立新分支 → push -u。同名分支（本機或遠端）已存在、
 * 沒有 origin，一律回報並停止，不覆蓋、不強制。
 */

export interface StartWorkDeps {
  runGit: GitRunner;
  /** 讀專案版本（原始字串）；由外部決定來源。 */
  readVersion: (localPath: string, source: StoredBranchRule["versionSource"]) => Promise<string | null>;
  now: () => Date;
}

type Blocked = { ok: false; reason: StartWorkBlockReason; message: string };
type Prepared = { ok: true; plan: StartWorkPlan; localPath: string } | Blocked;

const MAX_SEQ = 99;
const MAX_STEP_OUTPUT = 2_000;

const blocked = (reason: StartWorkBlockReason, message: string): Blocked => ({ ok: false, reason, message });

const failureText = (stderr: string, stdout: string): string => redactSecrets((stderr || stdout).trim()).slice(0, MAX_STEP_OUTPUT);

const resolveBaseBranch = async (deps: StartWorkDeps, project: Project, localPath: string): Promise<string | null> => {
  if (project.defaultBranch && isValidBranchName(project.defaultBranch)) {
    return project.defaultBranch;
  }
  const head = await deps.runGit(localPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const name = head.code === 0 ? head.stdout.trim().replace(/^origin\//, "") : "";
  return isValidBranchName(name) ? name : null;
};

/** 本機或遠端是否已有同名分支；遠端用 ls-remote 即時確認，不依賴可能過期的追蹤分支。 */
const branchExists = async (
  deps: StartWorkDeps,
  localPath: string,
  branch: string
): Promise<{ exists: boolean } | { error: string }> => {
  const local = await deps.runGit(localPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (local.code === 0) {
    return { exists: true };
  }
  const remote = await deps.runGit(localPath, ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`]);
  if (remote.code === 0) {
    return { exists: true };
  }
  // --exit-code：2 代表連線成功但沒有符合的 ref。其他結束碼是連線或驗證問題。
  return remote.code === 2 ? { exists: false } : { error: failureText(remote.stderr, remote.stdout) };
};

const prepare = async (
  deps: StartWorkDeps,
  project: Project,
  rule: StoredBranchRule,
  input: StartWorkInput
): Promise<Prepared> => {
  const localPath = project.localPath;
  if (!localPath) {
    return blocked("no-local-path", "這個專案還沒有設定本機路徑");
  }

  const parsed = parseTemplate(rule.template);
  if (!parsed.ok) {
    return blocked("template", "分支命名範本不正確，請先到設定修正");
  }
  const tokens = templateTokens(parsed.parts);

  const inside = await deps.runGit(localPath, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return blocked("not-a-repo", "本機路徑不是 git repo，或路徑不存在");
  }

  const origin = await deps.runGit(localPath, ["remote", "get-url", "origin"]);
  if (origin.code !== 0) {
    return blocked("no-origin", "這個 repo 還沒有設定 origin");
  }

  const status = await deps.runGit(localPath, ["status", "--porcelain"]);
  if (status.code !== 0) {
    return blocked("not-a-repo", "無法讀取 git 狀態");
  }
  if (status.stdout.trim().length > 0) {
    return blocked("dirty", "工作區有未提交的異動，請先 commit 或 stash 後再開工");
  }

  const baseBranch = await resolveBaseBranch(deps, project, localPath);
  if (!baseBranch) {
    return blocked("default-branch", "找不到預設分支，請先在專案設定預設分支或讓監視器完成第一次檢查");
  }

  const values: Partial<BranchValues> = { ...dateValues(deps.now()) };

  if (tokens.includes("version")) {
    const raw = await deps.readVersion(localPath, rule.versionSource);
    const version = raw === null ? null : normalizeVersion(raw);
    if (version === null) {
      return blocked("version", `讀不到版本號（來源：${rule.versionSource}）`);
    }
    values.version = version;
  }

  if (tokens.includes("user")) {
    const name = await deps.runGit(localPath, ["config", "user.name"]);
    const user = name.code === 0 ? sanitizeSlug(name.stdout.trim()) : null;
    if (user === null) {
      return blocked("user", "請先設定 git user.name");
    }
    values.user = user;
  }

  if (tokens.includes("type")) {
    if (typeof input.type !== "string" || !TYPE_PATTERN.test(input.type)) {
      return blocked("input", "請選擇或輸入分支類型（小寫英文字母，如 feat、fix）");
    }
    values.type = input.type;
  }

  if (tokens.includes("slug")) {
    const slug = sanitizeSlug(input.slug ?? "");
    if (slug === null) {
      return blocked("input", "請輸入分支的簡短描述");
    }
    values.slug = slug;
  }

  const build = (seq: number): string | Blocked => {
    try {
      return renderBranchName(rule.template, { ...values, seq: String(seq) });
    } catch (error) {
      return blocked("template", error instanceof TemplateRenderError ? error.message : "無法產生分支名稱");
    }
  };

  // 有 {seq} 就找第一個沒被用掉的流水號；沒有的話撞名就停止。
  const useSeq = tokens.includes("seq");
  for (let seq = 1; seq <= (useSeq ? MAX_SEQ : 1); seq += 1) {
    const candidate = build(seq);
    if (typeof candidate !== "string") {
      return candidate;
    }
    const existing = await branchExists(deps, localPath, candidate);
    if ("error" in existing) {
      return blocked("remote", `無法向 origin 確認分支是否已存在：${existing.error || "連線失敗"}`);
    }
    if (!existing.exists) {
      return {
        ok: true,
        localPath,
        plan: {
          branch: candidate,
          baseBranch,
          steps: [
            "git fetch origin",
            `git checkout ${baseBranch}`,
            `git pull --ff-only origin ${baseBranch}`,
            `git checkout -b ${candidate}`,
            `git push -u origin ${candidate}`
          ]
        }
      };
    }
    if (!useSeq) {
      return blocked("exists", `分支 ${candidate} 已經存在，不會覆蓋`);
    }
  }
  return blocked("exists", `今天的流水號已用到 ${MAX_SEQ}，無法再產生新的分支名稱`);
};

export const previewStartWork = async (
  deps: StartWorkDeps,
  project: Project,
  rule: StoredBranchRule,
  input: StartWorkInput
): Promise<StartWorkPreview> => {
  const prepared = await prepare(deps, project, rule, input);
  return prepared.ok ? { ok: true, plan: prepared.plan } : prepared;
};

/**
 * 實際執行。會重新計算一次分支名稱，與使用者確認時看到的不同（跨日、流水號被別人用掉）就拒絕，
 * 確保實際建立的正是使用者確認過的那個名稱。
 */
export const executeStartWork = async (
  deps: StartWorkDeps,
  project: Project,
  rule: StoredBranchRule,
  input: StartWorkInput,
  expectedBranch: string
): Promise<StartWorkResult> => {
  const prepared = await prepare(deps, project, rule, input);
  if (!prepared.ok) {
    return { ok: false, reason: prepared.reason, message: prepared.message, steps: [] };
  }
  const { plan, localPath } = prepared;
  if (plan.branch !== expectedBranch) {
    return {
      ok: false,
      reason: "changed",
      message: `分支名稱已變動（${expectedBranch} → ${plan.branch}），請重新確認`,
      steps: []
    };
  }

  const commands: ReadonlyArray<readonly string[]> = [
    ["fetch", "origin"],
    ["checkout", plan.baseBranch],
    ["pull", "--ff-only", "origin", plan.baseBranch],
    ["checkout", "-b", plan.branch],
    ["push", "-u", "origin", plan.branch]
  ];

  const steps: StepReport[] = [];
  for (const [index, args] of commands.entries()) {
    const result = await deps.runGit(localPath, args);
    const output = failureText(result.stderr, result.stdout);
    const ok = result.code === 0;
    steps.push({ label: plan.steps[index] as string, ok, output });
    if (!ok) {
      const partial = index >= 3 ? "（本機分支已建立，但尚未成功推送到 origin）" : "";
      return {
        ok: false,
        reason: "step-failed",
        message: `「${plan.steps[index]}」失敗${result.timedOut ? "（逾時）" : ""}${partial}`,
        steps
      };
    }
  }
  return { ok: true, branch: plan.branch, steps };
};
