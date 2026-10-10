import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { PUSH } from "@shared/ipc";
import { broadcast } from "@main/broadcast";
import type { AiService } from "@main/ai/service";
import type { Db } from "@main/db/database";
import { buildBaseEnv, resolveLoginPath } from "@main/exec/env";
import { createOutputHub } from "@main/exec/output-hub";
import { runProcess } from "@main/exec/run-process";
import { runGit } from "@main/git/run-git";
import type { StartWorkDeps } from "@main/git/start-work";
import { postJson } from "@main/http-post";
import type { Logger } from "@main/logger";
import { showDesktopNotification } from "@main/notifier";
import { showConfirmDialog } from "@main/rules/confirm-dialog";
import { createRuleEngine, type RuleEngine } from "@main/rules/engine";
import { createAiExecutors } from "@main/rules/executors/ai";
import { createCommandExecutors } from "@main/rules/executors/command";
import { createNotifyExecutors } from "@main/rules/executors/notify";
import { createWorkBranchExecutor } from "@main/rules/executors/work-branch";
import type { Vault } from "@main/vault/vault";

export interface RuleRuntimeDeps {
  db: Db;
  vault: Vault;
  git: StartWorkDeps;
  logger: Logger;
  ai: AiService;
  onNotificationClick: () => void;
}

const LOGIN_PATH_TIMEOUT_MS = 5_000;

/** 問使用者的登入 shell 實際的 PATH（從 Finder 啟動的 App 只有極簡的 PATH）。 */
const probeLoginShell = (file: string, args: readonly string[]): Promise<{ code: number | null; stdout: string }> =>
  new Promise((resolve) => {
    execFile(file, [...args], { timeout: LOGIN_PATH_TIMEOUT_MS, env: process.env, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve({ code: error ? 1 : 0, stdout: stdout ?? "" });
    });
  });

/**
 * 組裝規則引擎：動作執行器、原生確認視窗、日誌。
 * 登入 shell 的 PATH 在背景解析，解析完成前先用 App 自己的 PATH 或備用值。
 */
export const createRuleRuntime = (deps: RuleRuntimeDeps): RuleEngine => {
  let loginPath: string | null = null;
  void resolveLoginPath(probeLoginShell).then((resolved) => {
    loginPath = resolved;
  });

  /** 依序從保險庫取出敏感環境變數；明文只活在 fn 執行期間。 */
  const withSecretEnv = async <T,>(
    ruleId: number,
    names: readonly string[],
    fn: (secrets: Record<string, string>) => Promise<T>
  ): Promise<T> => {
    const collected: Record<string, string> = {};
    const next = async (index: number): Promise<T> => {
      const name = names[index];
      if (name === undefined) {
        return fn({ ...collected });
      }
      return deps.vault.useSecret(`env.${ruleId}.${name}`, async (value) => {
        collected[name] = value;
        return next(index + 1);
      });
    };
    return next(0);
  };

  const hub = createOutputHub({
    emit: (events) => broadcast(PUSH.commandOutput, events),
    now: Date.now,
    newId: randomUUID
  });

  return createRuleEngine({
    db: deps.db,
    now: Date.now,
    log: (entry) => deps.logger.log(entry),
    confirm: (request) => showConfirmDialog(request),
    executors: {
      ...createNotifyExecutors({
        showNotification: (title, body) => void showDesktopNotification(title, body, deps.onNotificationClick),
        post: postJson,
        withSlackUrl: (fn) => deps.vault.useSecret("notify.slack_webhook", fn)
      }),
      ...createWorkBranchExecutor({ db: deps.db, git: deps.git, now: Date.now }),
      ...createAiExecutors(deps.ai),
      ...createCommandExecutors({
        db: deps.db,
        run: runProcess,
        gitRun: runGit,
        baseEnv: () => buildBaseEnv(process.env, loginPath),
        withSecretEnv,
        hub,
        log: (entry) => deps.logger.log(entry),
        now: Date.now,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        isDirectory: async (path) => (await stat(path).catch(() => null))?.isDirectory() === true
      })
    }
  });
};
