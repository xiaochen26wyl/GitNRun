import { execFile } from "node:child_process";

/**
 * 執行 git 的唯一原語：一律 execFile + 參數陣列，不經過 shell，所以參數裡的特殊字元
 * 不會被解讀成指令。呼叫端負責確保參數（分支名稱等）已通過驗證。
 */

export interface GitResult {
  /** 結束碼；無法啟動（找不到 git、工作目錄不存在）時為 -1。 */
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type GitRunner = (cwd: string, args: readonly string[]) => Promise<GitResult>;

export const GIT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export const runGit: GitRunner = (cwd, args) =>
  new Promise((resolve) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        // 不要在背景等待帳密輸入；需要驗證就直接失敗，由使用者的 credential helper 處理。
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr, timedOut: false });
          return;
        }
        const failure = error as NodeJS.ErrnoException & { killed?: boolean };
        resolve({
          code: typeof failure.code === "number" ? failure.code : -1,
          stdout: stdout ?? "",
          stderr: stderr || (typeof failure.code === "string" ? failure.code : ""),
          timedOut: failure.killed === true
        });
      }
    );
  });
