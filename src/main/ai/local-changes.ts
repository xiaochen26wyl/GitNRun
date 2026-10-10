import type { ChangedFile, ChangedFileStatus } from "@shared/events";
import type { GitRunner } from "@main/git/run-git";

/** 讀專案本機尚未提交的變更：先看已暫存（staged）的，沒有才看工作區相對於 HEAD 的變更。 */

export interface LocalChanges {
  staged: boolean;
  files: ChangedFile[];
  diff: string;
}

export type LocalChangesResult =
  | { ok: true; changes: LocalChanges }
  | { ok: false; reason: "nothing-to-send" | "git-error" };

const STATUS: Record<string, ChangedFileStatus> = { A: "added", C: "added", D: "removed", M: "modified", T: "modified", R: "renamed" };

/** `git diff --name-status` 的輸出：`M\tpath`、`R100\told\tnew`。 */
export const parseNameStatus = (output: string): ChangedFile[] =>
  output.split("\n").flatMap((line) => {
    const [code, first, second] = line.split("\t");
    if (!code || first === undefined) return [];
    const status = STATUS[code.charAt(0)] ?? "modified";
    return status === "renamed" && second !== undefined
      ? [{ path: second, status, previousPath: first } satisfies ChangedFile]
      : [{ path: first, status } satisfies ChangedFile];
  });

// core.quotepath=off：路徑含中文時不要被轉成 \346\226... 的跳脫格式。--no-ext-diff／--no-textconv：不執行設定裡的外部程式。
const base = ["-c", "core.quotepath=off", "diff", "--no-color", "--no-ext-diff", "--no-textconv"] as const;

export const collectLocalChanges = async (runGit: GitRunner, cwd: string): Promise<LocalChangesResult> => {
  for (const [staged, target] of [[true, ["--cached"]], [false, ["HEAD"]]] as const) {
    const names = await runGit(cwd, [...base, ...target, "--name-status"]);
    if (names.code !== 0) {
      return { ok: false, reason: "git-error" };
    }
    const files = parseNameStatus(names.stdout);
    if (files.length === 0) {
      continue;
    }
    const patch = await runGit(cwd, [...base, ...target]);
    return patch.code === 0 ? { ok: true, changes: { staged, files, diff: patch.stdout } } : { ok: false, reason: "git-error" };
  }
  return { ok: false, reason: "nothing-to-send" };
};
