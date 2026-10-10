import type { RuleAction } from "@shared/rules";
import type { Db } from "@main/db/database";
import { recordSelfSha } from "@main/db/rules-repo";
import { eventEnv, outputsEnv } from "@main/exec/env";
import { expandGitArgs } from "@main/exec/git-args";
import type { OutputHub } from "@main/exec/output-hub";
import type { ProcessResult, RunProcessOptions } from "@main/exec/run-process";
import type { GitRunner } from "@main/git/run-git";
import type { LogEntry } from "@main/logger";
import { createValueRedactor, redactSecrets } from "@main/log-redaction";
import type { ActionContext, ActionExecutors, ActionResult } from "@main/rules/engine";
import { SecretMissingError, SecretUnreadableError } from "@main/vault/vault";

/**
 * 在本機執行指令的動作：git 與自訂 shell。
 *
 * - 工作目錄只能是這個事件所屬專案「已登錄的本機路徑」，不接受任意目錄。
 * - 子行程只拿到白名單環境＋規則設定的環境變數＋PW_* 事件資料；敏感環境變數的值只在執行期間
 *   從保險庫取出、只活在這個子行程的環境裡。
 * - 事件內容只以環境變數傳入，不拼進指令；git 參數的 {branch} 等變數先驗證再代入。
 * - 輸出（即時串流、日誌、動作結果）一律先脫敏，已知的密鑰值做精確比對。
 */

export interface CommandDeps {
  db: Db;
  run: (options: RunProcessOptions) => Promise<ProcessResult>;
  /** 用來在 push／commit 之後取得新的 HEAD（登記為「規則自己造成的」）。 */
  gitRun: GitRunner;
  baseEnv: () => Record<string, string>;
  /** 取出規則的敏感環境變數；明文只活在回呼內。 */
  withSecretEnv: <T>(ruleId: number, names: readonly string[], fn: (secrets: Record<string, string>) => Promise<T>) => Promise<T>;
  hub: OutputHub;
  log: (entry: LogEntry) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  isDirectory: (path: string) => Promise<boolean>;
  shellPath?: string;
}

type ShellAction = Extract<RuleAction, { type: "shell" }>;
type GitAction = Extract<RuleAction, { type: "git" }>;

const MAX_RETRY_WAIT_MS = 5 * 60 * 1000;
const MESSAGE_TAIL_LINES = 3;
const MESSAGE_MAX = 400;
const LOG_OUTPUT_MAX = 8_000;
/** 這些 git 子指令會產生新的 commit，把新的 HEAD 登記起來，避免同一條規則被自己的推送再次觸發。 */
const SELF_RECORDING_GIT_COMMANDS: ReadonlySet<string> = new Set(["push", "commit", "merge"]);

const fail = (message: string): ActionResult => ({ status: "failed", message });

/** 輸出的最後幾行（失敗時 stderr 優先），給動作結果與規則執行紀錄看。 */
const outputTail = (result: ProcessResult, redact: (text: string) => string): string => {
  const source = result.code === 0 ? result.stdout : result.stderr || result.stdout;
  const lines = redact(source)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  return lines.slice(-MESSAGE_TAIL_LINES).join(" ⏎ ").slice(-MESSAGE_MAX);
};

const seconds = (ms: number): string => (ms / 1000).toFixed(1);

export const createCommandExecutors = (deps: CommandDeps): Pick<ActionExecutors, "git" | "shell"> => {
  const shell = deps.shellPath ?? "/bin/zsh";

  const workingDirectory = async (context: ActionContext): Promise<{ ok: true; cwd: string } | { ok: false; message: string }> => {
    const path = context.project.localPath;
    if (!path) {
      return { ok: false, message: "這個專案還沒有設定本機路徑，不能在本機執行指令" };
    }
    return (await deps.isDirectory(path)) ? { ok: true, cwd: path } : { ok: false, message: "專案的本機路徑不存在或不是資料夾" };
  };

  interface Job {
    label: string;
    file: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    timeoutSec: number;
    retries: number;
    retryDelaySec: number;
    secretValues: string[];
    context: ActionContext;
  }

  const execute = async (job: Job): Promise<{ result: ActionResult; ok: boolean }> => {
    const redact = (text: string): string => redactSecrets(createValueRedactor(job.secretValues)(text));
    const handle = deps.hub.begin(job.label, redact);
    let last: ProcessResult;
    let attempts = 0;

    for (;;) {
      attempts += 1;
      last = await deps.run({
        file: job.file,
        args: job.args,
        cwd: job.cwd,
        env: job.env,
        timeoutMs: job.timeoutSec * 1000,
        onOutput: (chunk) => handle.write(chunk.stream, chunk.text)
      });
      const succeeded = last.code === 0 && !last.timedOut && last.spawnError === undefined;
      // 啟動不了（找不到程式、目錄有問題）是設定問題，重試也不會好。
      if (succeeded || last.spawnError !== undefined || attempts > job.retries) {
        break;
      }
      const wait = Math.min(job.retryDelaySec * 1000 * 2 ** (attempts - 1), MAX_RETRY_WAIT_MS);
      handle.note(`第 ${attempts} 次失敗，${seconds(wait)} 秒後重試`);
      await deps.sleep(wait);
    }

    const succeeded = last.code === 0 && !last.timedOut && last.spawnError === undefined;
    const status = succeeded ? "success" : last.timedOut ? "timeout" : "failed";
    handle.end(status);

    deps.log({
      category: "command",
      level: succeeded ? "info" : "warn",
      message: `${job.context.project.name}：${job.label} → ${succeeded ? "成功" : last.timedOut ? "逾時" : "失敗"}`,
      detail: {
        rule: job.context.rule.name,
        exitCode: last.code,
        signal: last.signal,
        attempts,
        durationMs: last.durationMs,
        outputTruncated: last.truncated,
        stdout: redact(last.stdout).slice(-LOG_OUTPUT_MAX),
        stderr: redact(last.stderr).slice(-LOG_OUTPUT_MAX)
      }
    });

    const took = `${seconds(last.durationMs)} 秒`;
    const tail = outputTail(last, redact);
    if (last.spawnError !== undefined) {
      return { ok: false, result: fail(`無法啟動（${last.spawnError}）`) };
    }
    if (last.timedOut) {
      return { ok: false, result: { status: "timeout", message: `逾時（超過 ${job.timeoutSec} 秒）已終止${tail ? `：${tail}` : ""}` } };
    }
    if (last.code !== 0) {
      const how = last.code === null ? `被訊號 ${last.signal ?? ""} 終止` : `結束碼 ${last.code}`;
      return { ok: false, result: fail(`失敗（${how}，${took}${attempts > 1 ? `，共嘗試 ${attempts} 次` : ""}）${tail ? `：${tail}` : ""}`) };
    }
    return { ok: true, result: { status: "success", message: `完成（${took}）${tail ? `：${tail}` : ""}` } };
  };

  const secretsFor = async <T,>(
    context: ActionContext,
    names: readonly string[],
    fn: (secrets: Record<string, string>) => Promise<T>
  ): Promise<T | ActionResult> => {
    try {
      return await deps.withSecretEnv(context.rule.id, names, fn);
    } catch (error) {
      if (error instanceof SecretMissingError) {
        return fail(`尚未設定敏感環境變數 ${error.secretName.split(".").pop() ?? ""} 的值`);
      }
      if (error instanceof SecretUnreadableError) {
        return fail(`敏感環境變數 ${error.secretName.split(".").pop() ?? ""} 無法解密，請重新輸入`);
      }
      throw error;
    }
  };

  const isActionResult = (value: unknown): value is ActionResult =>
    typeof value === "object" && value !== null && "status" in value && "message" in value;

  const describeEnv = (action: ShellAction): string => {
    const plain = action.env.map((item) => `${item.name}=${item.value}`);
    const secret = action.secretEnvNames.map((name) => `${name}（敏感，值不顯示）`);
    return [`PW_*（事件資料：分支、推送者、訊息、SHA 等）`, ...plain, ...secret].join("\n  ");
  };

  return {
    shell: {
      async describe(action, context) {
        const where = await workingDirectory(context);
        return [
          where.ok ? `在 ${where.cwd} 以 zsh 執行（逾時 ${action.timeoutSec} 秒${action.retries > 0 ? `，失敗最多重試 ${action.retries} 次` : ""}）：` : `⚠ ${where.message}`,
          "────",
          action.command,
          "────",
          `環境變數：\n  ${describeEnv(action)}`
        ].join("\n");
      },

      async run(action, context) {
        const where = await workingDirectory(context);
        if (!where.ok) {
          return fail(where.message);
        }
        const outcome = await secretsFor(context, action.secretEnvNames, async (secrets) => {
          // 後面的覆蓋前面的：事件資料（PW_*）最後套用，規則設定的環境變數蓋不掉它。
          const env = {
            ...deps.baseEnv(),
            ...Object.fromEntries(action.env.map((item) => [item.name, item.value])),
            ...secrets,
            ...outputsEnv(context.variables),
            ...eventEnv(context.event, context.project)
          };
          return execute({
            label: action.command.split("\n", 1)[0]?.slice(0, 120) ?? "shell",
            file: shell,
            args: ["-c", action.command],
            cwd: where.cwd,
            env,
            timeoutSec: action.timeoutSec,
            retries: action.retries,
            retryDelaySec: action.retryDelaySec,
            secretValues: Object.values(secrets),
            context
          });
        });
        return isActionResult(outcome) ? outcome : outcome.result;
      }
    },

    git: {
      async describe(action: GitAction, context) {
        const where = await workingDirectory(context);
        const expanded = expandGitArgs(action.args, context.event, context.variables);
        return [
          where.ok ? `在 ${where.cwd} 執行（逾時 ${action.timeoutSec} 秒${action.retries > 0 ? `，失敗最多重試 ${action.retries} 次` : ""}）：` : `⚠ ${where.message}`,
          expanded.ok ? `git ${action.command} ${expanded.args.join(" ")}`.trimEnd() : `⚠ ${expanded.message}`
        ].join("\n");
      },

      async run(action, context) {
        const where = await workingDirectory(context);
        if (!where.ok) {
          return fail(where.message);
        }
        const expanded = expandGitArgs(action.args, context.event, context.variables);
        if (!expanded.ok) {
          return fail(expanded.message);
        }

        const { ok, result } = await execute({
          label: `git ${action.command} ${expanded.args.join(" ")}`.trimEnd().slice(0, 160),
          file: "git",
          args: [action.command, ...expanded.args],
          cwd: where.cwd,
          env: { ...deps.baseEnv(), ...outputsEnv(context.variables), ...eventEnv(context.event, context.project) },
          timeoutSec: action.timeoutSec,
          retries: action.retries,
          retryDelaySec: action.retryDelaySec,
          secretValues: [],
          context
        });

        // 新的 HEAD 會在下一輪輪詢被當成新事件；登記起來，這條規則就不會被自己的推送再次觸發。
        if (ok && SELF_RECORDING_GIT_COMMANDS.has(action.command)) {
          const head = await deps.gitRun(where.cwd, ["rev-parse", "HEAD"]);
          const sha = head.stdout.trim();
          if (head.code === 0 && /^[0-9a-f]{40,64}$/i.test(sha)) {
            recordSelfSha(deps.db, context.rule.id, sha, deps.now());
          }
        }
        return result;
      }
    }
  };
};
