import type { PushEvent } from "@shared/events";
import type { Project } from "@shared/projects";
import { eventVariables, expandEventText } from "@shared/rules";
import type { StartWorkInput } from "@shared/start-work";
import { getEffectiveBranchRule } from "@main/db/branch-rules-repo";
import type { Db } from "@main/db/database";
import { recordSelfSha } from "@main/db/rules-repo";
import { executeStartWork, previewStartWork, type StartWorkDeps } from "@main/git/start-work";
import type { ActionExecutors } from "@main/rules/engine";

/**
 * 「開工」動作：依專案目前生效的分支命名規則建立並推送新分支。
 * 推送成功後把新分支的 head SHA 記為「這條規則自己造成的」，下一輪輪詢看到它時就不會再觸發同一條規則。
 */

export interface WorkBranchDeps {
  db: Db;
  git: StartWorkDeps;
  now: () => number;
}

export const createWorkBranchExecutor = (deps: WorkBranchDeps): Pick<ActionExecutors, "create_work_branch"> => {
  const inputFor = (
    action: { branchType?: string; slug?: string },
    context: { event: PushEvent; project: Pick<Project, "name"> }
  ): StartWorkInput => {
    const input: StartWorkInput = {};
    if (action.branchType) input.type = action.branchType;
    // slug 可以帶 {branch}、{pusher} 等變數；之後仍會經過 sanitizeSlug，所以不可能夾帶特殊字元。
    if (action.slug) input.slug = expandEventText(action.slug, eventVariables(context.event, context.project));
    return input;
  };

  return {
    create_work_branch: {
      async describe(action, context) {
        const rule = getEffectiveBranchRule(deps.db, context.project.id);
        const preview = await previewStartWork(deps.git, context.project, rule, inputFor(action, context));
        return preview.ok
          ? `在 ${context.project.name} 建立並推送分支 ${preview.plan.branch}（從 ${preview.plan.baseBranch} 出發）\n${preview.plan.steps.join("\n")}`
          : `無法開工：${preview.message}`;
      },

      async run(action, context) {
        const rule = getEffectiveBranchRule(deps.db, context.project.id);
        const input = inputFor(action, context);
        const preview = await previewStartWork(deps.git, context.project, rule, input);
        if (!preview.ok) {
          return { status: "failed", message: `無法開工：${preview.message}` };
        }

        const result = await executeStartWork(deps.git, context.project, rule, input, preview.plan.branch);
        if (!result.ok) {
          return { status: "failed", message: result.message };
        }

        // 取得新分支的 head SHA 並登記為自己造成的推送（取不到就算了，冷卻與次數上限仍會擋住失控）。
        const localPath = context.project.localPath;
        if (localPath) {
          const head = await deps.git.runGit(localPath, ["rev-parse", "HEAD"]);
          const sha = head.stdout.trim();
          if (head.code === 0 && /^[0-9a-f]{40,64}$/i.test(sha)) {
            recordSelfSha(deps.db, context.rule.id, sha, deps.now());
          }
        }
        return { status: "success", message: `已建立並推送分支 ${result.branch}` };
      }
    }
  };
};
