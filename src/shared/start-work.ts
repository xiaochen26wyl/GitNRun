/** 「開工」（依分支命名規則建立並推送新分支）的共用型別。 */

export type StartWorkBlockReason =
  | "no-local-path"
  | "not-a-repo"
  | "no-origin"
  | "dirty"
  | "exists"
  | "version"
  | "user"
  | "input"
  | "default-branch"
  | "remote"
  | "template"
  | "changed";

export interface StartWorkInput {
  type?: string;
  slug?: string;
}

export interface StartWorkPlan {
  /** 將會建立的分支名稱。 */
  branch: string;
  /** 從哪個分支出發。 */
  baseBranch: string;
  /** 將依序執行的 git 指令（顯示給使用者確認）。 */
  steps: string[];
}

export type StartWorkPreview =
  | { ok: true; plan: StartWorkPlan }
  | { ok: false; reason: StartWorkBlockReason; message: string };

export interface StepReport {
  label: string;
  ok: boolean;
  /** 已脫敏、已截斷的輸出。 */
  output: string;
}

export type StartWorkResult =
  | { ok: true; branch: string; steps: StepReport[] }
  | { ok: false; reason: StartWorkBlockReason | "step-failed"; message: string; steps: StepReport[] };
