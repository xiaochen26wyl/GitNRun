import { checkBranchName } from "@shared/branch-template";
import type { Project } from "@shared/projects";
import type { Db } from "@main/db/database";
import { getEffectiveBranchRule } from "@main/db/branch-rules-repo";

/** 給 ingestion pipeline 用：這個分支名稱是否違反該專案目前生效的命名規則。 */
export const createBranchChecker =
  (db: Db) =>
  (project: Project, branch: string): boolean => {
    const rule = getEffectiveBranchRule(db, project.id);
    return checkBranchName(branch, rule) === "violation";
  };
