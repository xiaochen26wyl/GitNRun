import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { CommandOutputEvent } from "@shared/command-output";
import type { Project } from "@shared/projects";
import type { Rule, RuleAction } from "@shared/rules";
import { addProject, getProject } from "@main/db/projects-repo";
import { createRule, isSelfCaused } from "@main/db/rules-repo";
import { createOutputHub } from "@main/exec/output-hub";
import { runProcess, type ProcessResult, type RunProcessOptions } from "@main/exec/run-process";
import type { GitResult } from "@main/git/run-git";
import type { LogEntry } from "@main/logger";
import { createCommandExecutors } from "@main/rules/executors/command";
import { SecretMissingError, SecretUnreadableError } from "@main/vault/vault";
import { createTestDb, storeEvent } from "./helpers/db";

const TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const SECRET_ENV = "deploy-key-value-98765";

type Shell = Extract<RuleAction, { type: "shell" }>;
type Git = Extract<RuleAction, { type: "git" }>;

const shellAction = (overrides: Partial<Shell> = {}): Shell => ({
  type: "shell", command: "echo hi", timeoutSec: 30, env: [], secretEnvNames: [], retries: 0, retryDelaySec: 5, ...overrides
});
const gitAction = (overrides: Partial<Git> = {}): Git => ({
  type: "git", command: "pull", args: ["--ff-only"], timeoutSec: 60, retries: 0, retryDelaySec: 5, ...overrides
});

const processResult = (overrides: Partial<ProcessResult> = {}): ProcessResult => ({
  code: 0, signal: null, timedOut: false, durationMs: 1234, stdout: "", stderr: "", truncated: false, ...overrides
});

const setup = (options: {
  results?: ProcessResult[];
  dir?: boolean;
  secrets?: Record<string, string> | Error;
  head?: Partial<GitResult>;
  run?: (options: RunProcessOptions) => Promise<ProcessResult>;
} = {}) => {
  const db = createTestDb();
  const added = addProject(db, {
    owner: "acme", repo: "api", name: "acme/api", localPath: "/Users/me/api",
    branchFilter: ["*"], pollIntervalSec: 30, mode: "poll", enabled: true, aiEnabled: false
  });
  const project = getProject(db, added.id) as Project;
  const event = storeEvent(db, project.id, { branch: "main", ref: "refs/heads/main", headMessage: "feat: x", pusher: "alice" });
  const rule = createRule(db, {
    name: "r", enabled: true, priority: 1, matchMode: "all", conditions: [],
    actions: [{ type: "notify_system" }], cooldownSec: 0, skipConfirm: false
  });

  const runs: RunProcessOptions[] = [];
  const sleeps: number[] = [];
  const logs: LogEntry[] = [];
  const gitCalls: string[] = [];
  const events: CommandOutputEvent[] = [];
  const queue = [...(options.results ?? [])];

  const executors = createCommandExecutors({
    db,
    run: async (runOptions) => {
      runs.push(runOptions);
      if (options.run) return options.run(runOptions);
      runOptions.onOutput?.({ stream: "stdout", text: (queue[0]?.stdout ?? "") });
      return queue.shift() ?? processResult();
    },
    gitRun: async (_cwd, args) => {
      gitCalls.push(args.join(" "));
      return { code: 0, stdout: `${"f".repeat(40)}\n`, stderr: "", timedOut: false, ...options.head };
    },
    baseEnv: () => ({ PATH: "/usr/bin", HOME: "/Users/me" }),
    withSecretEnv: async (_ruleId, names, fn) => {
      if (options.secrets instanceof Error) throw options.secrets;
      const secrets = options.secrets ?? {};
      return fn(Object.fromEntries(names.map((name) => [name, secrets[name] ?? SECRET_ENV])));
    },
    hub: createOutputHub({ emit: (batch) => events.push(...batch), now: () => 1, newId: () => "run-1", schedule: (fn) => fn(), flushMs: 0 }),
    log: (entry) => logs.push(entry),
    now: () => 4242,
    sleep: async (ms) => void sleeps.push(ms),
    isDirectory: async () => options.dir ?? true
  });

  const context = { rule: rule as Rule, event, project };
  return { db, executors, context, runs, sleeps, logs, gitCalls, events, rule };
};

describe("shell action", () => {
  it("runs the command with zsh -c in the project's registered folder", async () => {
    const t = setup();
    const result = await t.executors.shell!.run(shellAction({ command: "make build" }), t.context);

    assert.equal(result.status, "success");
    assert.equal(t.runs[0]?.file, "/bin/zsh");
    assert.deepEqual(t.runs[0]?.args, ["-c", "make build"]);
    assert.equal(t.runs[0]?.cwd, "/Users/me/api");
    assert.equal(t.runs[0]?.timeoutMs, 30_000);
    assert.match(result.message, /完成/);
  });

  it("builds the environment: base, rule variables, secrets — and event data always wins", async () => {
    const t = setup();
    await t.executors.shell!.run(
      shellAction({ env: [{ name: "STAGE", value: "prod" }, { name: "PW_BRANCH", value: "spoofed" }], secretEnvNames: ["DEPLOY_KEY"] }),
      t.context
    );
    const env = t.runs[0]?.env ?? {};

    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.STAGE, "prod");
    assert.equal(env.DEPLOY_KEY, SECRET_ENV);
    assert.equal(env.PW_BRANCH, "main", "a rule cannot spoof event data");
    assert.equal(env.PW_PUSHER, "alice");
    assert.equal(env.PW_MESSAGE, "feat: x");
    assert.equal(env.GITHUB_TOKEN, undefined, "nothing from the app's own environment leaks in");
  });

  it("refuses to run without a registered, existing project folder", async () => {
    const noPath = setup();
    const result = await noPath.executors.shell!.run(shellAction(), { ...noPath.context, project: { ...noPath.context.project, localPath: null } });
    assert.equal(result.status, "failed");
    assert.match(result.message, /本機路徑/);
    assert.equal(noPath.runs.length, 0);

    const missingDir = setup({ dir: false });
    assert.match((await missingDir.executors.shell!.run(shellAction(), missingDir.context)).message, /不存在/);
    assert.equal(missingDir.runs.length, 0);
  });

  it("reports failure with the exit code and the last output lines", async () => {
    const t = setup({ results: [processResult({ code: 2, stderr: "warn\nbuild failed: missing file\n", durationMs: 2500 })] });
    const result = await t.executors.shell!.run(shellAction(), t.context);

    assert.equal(result.status, "failed");
    assert.match(result.message, /結束碼 2/);
    assert.match(result.message, /build failed: missing file/);
  });

  it("reports a timeout distinctly", async () => {
    const t = setup({ results: [processResult({ code: null, signal: "SIGTERM", timedOut: true })] });
    const result = await t.executors.shell!.run(shellAction({ timeoutSec: 7 }), t.context);
    assert.equal(result.status, "timeout");
    assert.match(result.message, /超過 7 秒/);
  });

  it("reports a program that cannot be started", async () => {
    const t = setup({ results: [processResult({ code: null, spawnError: "ENOENT" })] });
    const result = await t.executors.shell!.run(shellAction(), t.context);
    assert.equal(result.status, "failed");
    assert.match(result.message, /ENOENT/);
    assert.equal(t.runs.length, 1, "no point retrying something that cannot start");
  });
});

describe("retries", () => {
  it("retries a failing command with exponential backoff, then succeeds", async () => {
    const t = setup({ results: [processResult({ code: 1 }), processResult({ code: 1 }), processResult({ code: 0 })] });
    const result = await t.executors.shell!.run(shellAction({ retries: 3, retryDelaySec: 2 }), t.context);

    assert.equal(result.status, "success");
    assert.equal(t.runs.length, 3);
    assert.deepEqual(t.sleeps, [2_000, 4_000]);
  });

  it("gives up after the configured number of retries and says how many attempts were made", async () => {
    const t = setup({ results: [processResult({ code: 1 }), processResult({ code: 1 }), processResult({ code: 1 })] });
    const result = await t.executors.shell!.run(shellAction({ retries: 2, retryDelaySec: 1 }), t.context);

    assert.equal(result.status, "failed");
    assert.equal(t.runs.length, 3);
    assert.match(result.message, /共嘗試 3 次/);
  });

  it("caps a single wait at five minutes", async () => {
    const t = setup({ results: Array.from({ length: 6 }, () => processResult({ code: 1 })) });
    await t.executors.shell!.run(shellAction({ retries: 5, retryDelaySec: 200 }), t.context);
    assert.ok(t.sleeps.every((ms) => ms <= 5 * 60_000));
    assert.equal(t.sleeps.at(-1), 300_000);
  });

  it("does not retry when there are no retries configured", async () => {
    const t = setup({ results: [processResult({ code: 1 })] });
    await t.executors.shell!.run(shellAction(), t.context);
    assert.equal(t.runs.length, 1);
    assert.deepEqual(t.sleeps, []);
  });
});

describe("secrets never escape", () => {
  const leaky = processResult({ code: 1, stdout: `deploying with ${SECRET_ENV}\n`, stderr: `auth failed for ${SECRET_ENV} and ${TOKEN}\n` });

  it("redacts known secret values and token patterns from results, logs and live output", async () => {
    const t = setup({ results: [leaky] });
    const result = await t.executors.shell!.run(shellAction({ secretEnvNames: ["DEPLOY_KEY"] }), t.context);

    const everything = JSON.stringify([result, t.logs, t.events]);
    assert.ok(!everything.includes(SECRET_ENV), "known secret value");
    assert.ok(!everything.includes(TOKEN), "token pattern");
    assert.ok(everything.includes("[redacted]"));
  });

  it("describes the command without any secret value", async () => {
    const t = setup();
    const text = await t.executors.shell!.describe(shellAction({ command: "deploy.sh", env: [{ name: "STAGE", value: "prod" }], secretEnvNames: ["DEPLOY_KEY"] }), t.context);

    assert.match(text, /deploy\.sh/);
    assert.match(text, /\/Users\/me\/api/);
    assert.match(text, /STAGE=prod/);
    assert.match(text, /DEPLOY_KEY（敏感，值不顯示）/);
    assert.ok(!text.includes(SECRET_ENV));
  });

  it("explains a missing or unreadable secret without running anything", async () => {
    const missing = setup({ secrets: new SecretMissingError("env.1.DEPLOY_KEY") });
    const result = await missing.executors.shell!.run(shellAction({ secretEnvNames: ["DEPLOY_KEY"] }), missing.context);
    assert.equal(result.status, "failed");
    assert.match(result.message, /DEPLOY_KEY/);
    assert.equal(missing.runs.length, 0);

    const unreadable = setup({ secrets: new SecretUnreadableError("env.1.DEPLOY_KEY") });
    assert.match((await unreadable.executors.shell!.run(shellAction({ secretEnvNames: ["DEPLOY_KEY"] }), unreadable.context)).message, /重新輸入/);
  });
});

describe("git action", () => {
  it("runs git directly (no shell) with the validated arguments", async () => {
    const t = setup();
    const result = await t.executors.git!.run(gitAction({ command: "pull", args: ["--ff-only", "origin", "{branch}"] }), t.context);

    assert.equal(result.status, "success");
    assert.equal(t.runs[0]?.file, "git");
    assert.deepEqual(t.runs[0]?.args, ["pull", "--ff-only", "origin", "main"]);
    assert.equal(t.runs[0]?.timeoutMs, 60_000);
  });

  it("rejects dangerous or unusable arguments before running anything", async () => {
    const t = setup();
    const result = await t.executors.git!.run(gitAction({ command: "fetch", args: ["--upload-pack=touch /tmp/pwned", "origin"] }), t.context);
    assert.equal(result.status, "failed");
    assert.equal(t.runs.length, 0);

    const hostile = setup();
    hostile.context.event = { ...hostile.context.event, branch: "--upload-pack=evil" };
    assert.equal((await hostile.executors.git!.run(gitAction({ args: ["{branch}"] }), hostile.context)).status, "failed");
    assert.equal(hostile.runs.length, 0);
  });

  it("registers its own new HEAD after push, commit or merge so this rule ignores the resulting event", async () => {
    for (const command of ["push", "commit", "merge"] as const) {
      const t = setup();
      await t.executors.git!.run(gitAction({ command, args: ["origin"] }), t.context);
      assert.deepEqual(t.gitCalls, ["rev-parse HEAD"], command);
      assert.equal(isSelfCaused(t.db, t.rule.id, ["f".repeat(40)]), true, command);
    }
  });

  it("does not register anything for fetch/pull/checkout/branch, or after a failure", async () => {
    for (const command of ["fetch", "pull", "checkout", "branch"] as const) {
      const t = setup();
      await t.executors.git!.run(gitAction({ command, args: [] }), t.context);
      assert.deepEqual(t.gitCalls, [], command);
    }
    const failed = setup({ results: [processResult({ code: 1 })] });
    await failed.executors.git!.run(gitAction({ command: "push", args: [] }), failed.context);
    assert.deepEqual(failed.gitCalls, []);
    assert.equal(isSelfCaused(failed.db, failed.rule.id, ["f".repeat(40)]), false);
  });

  it("describes exactly what would run, or why it would not", async () => {
    const t = setup();
    assert.match(await t.executors.git!.describe(gitAction({ command: "push", args: ["-u", "origin", "{branch}"] }), t.context), /git push -u origin main/);
    assert.match(await t.executors.git!.describe(gitAction({ args: ["--exec=evil"] }), t.context), /⚠/);
    const noDir = setup({ dir: false });
    assert.match(await noDir.executors.git!.describe(gitAction(), noDir.context), /⚠/);
  });
});

describe("live output", () => {
  it("streams lines to the hub and finishes the run with the final status", async () => {
    const t = setup({ results: [processResult({ code: 0, stdout: "building\ndone\n" })] });
    await t.executors.shell!.run(shellAction({ command: "make" }), t.context);

    const kinds = t.events.map((event) => event.kind);
    assert.equal(kinds[0], "start");
    assert.equal(kinds.at(-1), "end");
    assert.deepEqual(
      t.events.flatMap((event) => (event.kind === "line" ? [event.text] : [])),
      ["building", "done"]
    );
    assert.equal((t.events.at(-1) as { status: string }).status, "success");
  });

  it("announces retries in the stream", async () => {
    const t = setup({ results: [processResult({ code: 1 }), processResult({ code: 0 })] });
    await t.executors.shell!.run(shellAction({ retries: 1, retryDelaySec: 3 }), t.context);
    assert.ok(t.events.some((event) => event.kind === "line" && event.stream === "system" && event.text.includes("重試")));
  });
});

describe("with a real shell: event content is data, never code", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gitnrun-cmd-")));
  after(() => rmSync(root, { recursive: true, force: true }));

  it("a malicious commit message and branch name reach the script only as environment variables", async () => {
    const t = setup({ run: (options) => runProcess({ ...options, cwd: root, killGraceMs: 100 }) });
    const marker = join(root, "pwned");
    const evil = {
      ...t.context.event,
      headMessage: `x"; touch ${marker}; echo "`,
      pusher: `$(touch ${marker})`,
      branch: `feature/a;touch ${marker}`
    };

    // 指令本身引用環境變數（被引號包住）；事件內容不會被當成程式碼重新解析。
    const result = await t.executors.shell!.run(
      shellAction({ command: 'printf "%s|%s|%s" "$PW_MESSAGE" "$PW_PUSHER" "$PW_BRANCH"' }),
      { ...t.context, event: evil }
    );

    assert.equal(result.status, "success");
    assert.equal(existsSync(marker), false, "nothing in the event was executed");
    assert.ok(result.message.includes("touch"), "the hostile text is still just text in the output");
  });
});
