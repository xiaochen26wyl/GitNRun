import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACTION_TYPES,
  WRITE_ACTION_TYPES,
  eventVariables,
  expandEventText,
  isWriteAction,
  validateRuleInput,
  type RuleInput
} from "@shared/rules";

const base = { name: "notify on main", actions: [{ type: "notify_system" }] };

describe("validateRuleInput", () => {
  it("fills defaults for a minimal rule", () => {
    const result = validateRuleInput(base);
    assert.ok(result.ok);
    assert.deepEqual(result.value, {
      name: "notify on main",
      enabled: true,
      priority: 100,
      matchMode: "all",
      conditions: [],
      actions: [{ type: "notify_system" }],
      cooldownSec: 0,
      skipConfirm: false
    });
  });

  it("accepts every condition and action type in normalised form", () => {
    const full: RuleInput = {
      name: "everything",
      enabled: true,
      priority: 5,
      matchMode: "any",
      conditions: [
        { type: "branch", patterns: ["main", "release/*"] },
        { type: "file", patterns: ["*.ts"] },
        { type: "pusher", names: ["alice"] },
        { type: "time", from: "09:00", to: "18:00", days: [1, 2, 3, 4, 5], match: "inside" },
        { type: "file_count", op: "gte", value: 10 },
        { type: "branch_violation", value: true },
        { type: "event_type", types: ["push", "create"] },
        { type: "project", projectIds: [1, 2] }
      ],
      actions: [
        { type: "notify_system", title: "t", body: "b" },
        { type: "notify_slack", text: "hi {branch}" },
        { type: "notify_webhook", url: "https://example.com/hook", includeEvent: false },
        { type: "notify_email", to: "me@example.com", subject: "s" },
        { type: "git", command: "pull", args: ["--ff-only", "origin", "main"], timeoutSec: 90, retries: 1, retryDelaySec: 10, continueOnFailure: true },
        { type: "shell", command: "echo hi\necho there", timeoutSec: 60, env: [{ name: "FOO", value: "bar" }], secretEnvNames: ["TOKEN"], retries: 2, retryDelaySec: 3 },
        { type: "create_work_branch", branchType: "feat", slug: "follow-up" },
        { type: "ai_commit_message" },
        { type: "ai_summary" }
      ],
      cooldownSec: 60,
      skipConfirm: false
    };
    const result = validateRuleInput(full);
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.value, full);
    // JSON 往返後仍相同（沒有殘留的 undefined 欄位）。
    assert.deepEqual(validateRuleInput(JSON.parse(JSON.stringify(result.value))), result);
  });

  it("rejects unknown action and condition types, listing what is allowed", () => {
    const action = validateRuleInput({ ...base, actions: [{ type: "rm_rf" }] });
    assert.ok(!action.ok);
    assert.ok(action.errors[0]?.includes("notify_system"));

    const condition = validateRuleInput({ ...base, conditions: [{ type: "moon_phase" }] });
    assert.ok(!condition.ok);
    assert.ok(condition.errors[0]?.includes("branch"));
  });

  it("requires a name and at least one action", () => {
    assert.ok(!validateRuleInput({ ...base, name: "" }).ok);
    assert.ok(!validateRuleInput({ ...base, name: "x".repeat(201) }).ok);
    assert.ok(!validateRuleInput({ ...base, actions: [] }).ok);
    assert.ok(!validateRuleInput({ name: "x" }).ok);
    assert.ok(!validateRuleInput(null).ok);
    assert.ok(!validateRuleInput([]).ok);
  });

  it("checks condition fields", () => {
    for (const bad of [
      { type: "branch", patterns: [] },
      { type: "branch", patterns: [""] },
      { type: "branch", patterns: "main" },
      { type: "time", from: "9:00", to: "18:00", days: [1], match: "inside" },
      { type: "time", from: "09:00", to: "25:00", days: [1], match: "inside" },
      { type: "time", from: "09:00", to: "18:00", days: [], match: "inside" },
      { type: "time", from: "09:00", to: "18:00", days: [7], match: "inside" },
      { type: "time", from: "09:00", to: "18:00", days: [1, 1], match: "inside" },
      { type: "time", from: "09:00", to: "18:00", days: [1], match: "during" },
      { type: "file_count", op: "eq", value: 1 },
      { type: "file_count", op: "gte", value: -1 },
      { type: "branch_violation", value: "yes" },
      { type: "event_type", types: ["rebase"] },
      { type: "event_type", types: [] },
      { type: "project", projectIds: [0] }
    ]) {
      assert.ok(!validateRuleInput({ ...base, conditions: [bad] }).ok, JSON.stringify(bad));
    }
  });

  it("checks action fields", () => {
    for (const bad of [
      { type: "git", command: "rebase", args: [] },
      { type: "git", command: "pull", args: Array(21).fill("x") },
      { type: "git", command: "pull", args: ["a\nb"] },
      { type: "shell", command: "" },
      { type: "shell", command: "ls", timeoutSec: 0 },
      { type: "shell", command: "ls", timeoutSec: 3601 },
      { type: "shell", command: "ls", env: [{ name: "lower", value: "x" }] },
      { type: "shell", command: "ls", env: [{ name: "OK", value: "a\nb" }] },
      { type: "shell", command: "ls", secretEnvNames: ["bad-name"] },
      { type: "shell", command: "ls", retries: 6 },
      { type: "shell", command: "ls", retries: -1 },
      { type: "shell", command: "ls", retryDelaySec: 0 },
      { type: "shell", command: "ls", retryDelaySec: 301 },
      { type: "git", command: "pull", args: [], timeoutSec: 0 },
      { type: "git", command: "pull", args: [], retries: 1.5 },
      { type: "notify_webhook", url: "ftp://example.com" },
      { type: "notify_webhook", url: "not a url" },
      { type: "notify_email", to: "nope" },
      { type: "notify_system", title: "x".repeat(201) },
      { type: "notify_system", continueOnFailure: "yes" }
    ]) {
      assert.ok(!validateRuleInput({ ...base, actions: [bad] }).ok, JSON.stringify(bad));
    }
  });

  it("bounds priority, cooldown and list sizes", () => {
    assert.ok(!validateRuleInput({ ...base, priority: 1.5 }).ok);
    assert.ok(!validateRuleInput({ ...base, priority: 1_000_000 }).ok);
    assert.ok(!validateRuleInput({ ...base, cooldownSec: -1 }).ok);
    assert.ok(!validateRuleInput({ ...base, cooldownSec: 86401 }).ok);
    assert.ok(!validateRuleInput({ ...base, conditions: Array(21).fill({ type: "branch_violation", value: true }) }).ok);
    assert.ok(!validateRuleInput({ ...base, actions: Array(21).fill({ type: "notify_system" }) }).ok);
  });

  it("reports every problem with a path so the form can point at it", () => {
    const result = validateRuleInput({ name: "", actions: [{ type: "git", command: "rebase" }, { type: "bogus" }] });
    assert.ok(!result.ok);
    assert.ok(result.errors.length >= 3);
    assert.ok(result.errors.some((error) => error.includes("動作[2]")));
  });
});

describe("write actions", () => {
  it("are exactly the ones that change things outside the app", () => {
    assert.deepEqual([...WRITE_ACTION_TYPES].sort(), ["create_work_branch", "git", "notify_email", "notify_webhook", "shell"]);
    for (const type of ["notify_system", "notify_slack", "ai_summary", "ai_commit_message"] as const) {
      assert.equal(isWriteAction(type), false, type);
    }
    assert.ok(ACTION_TYPES.every((type) => typeof isWriteAction(type) === "boolean"));
  });
});

describe("event text templates", () => {
  const event = {
    branch: "feature/x", pusher: "alice", headMessage: "feat: add $(rm -rf /)", afterSha: "abcdef1234567890",
    fileCount: 3, commits: [{}, {}], eventType: "push"
  } as never;

  it("substitutes known variables and leaves unknown ones", () => {
    const text = expandEventText("{project}:{branch} by {pusher} ({sha}) {nope}", eventVariables(event, { name: "acme/api" }));
    assert.equal(text, "acme/api:feature/x by alice (abcdef1) {nope}");
  });

  it("treats event content as plain text: nothing is evaluated or re-expanded", () => {
    const text = expandEventText("msg={message}", eventVariables(event, { name: "p" }));
    assert.equal(text, "msg=feat: add $(rm -rf /)");
    const tricky = expandEventText("{message}", { message: "{branch}", branch: "SHOULD-NOT-APPEAR" });
    assert.equal(tricky, "{branch}");
  });

  it("does not resolve prototype properties as variables", () => {
    assert.equal(expandEventText("{constructor} {toString}", {}), "{constructor} {toString}");
  });
});

describe("reserved environment variable names", () => {
  const shellWith = (extra: Record<string, unknown>) => ({ ...base, actions: [{ type: "shell", command: "ls", ...extra }] });

  it("rejects names that could change shell, git, loader or Node behaviour, or collide with event data", () => {
    for (const name of ["PATH", "HOME", "SHELL", "IFS", "BASH_ENV", "ZDOTDIR", "NODE_OPTIONS", "PW_BRANCH", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "GIT_SSH_COMMAND", "GIT_ASKPASS"]) {
      assert.ok(!validateRuleInput(shellWith({ env: [{ name, value: "x" }] })).ok, `env ${name}`);
      assert.ok(!validateRuleInput(shellWith({ secretEnvNames: [name] })).ok, `secret ${name}`);
    }
  });

  it("still allows ordinary names", () => {
    assert.ok(validateRuleInput(shellWith({ env: [{ name: "STAGE", value: "prod" }], secretEnvNames: ["API_TOKEN"] })).ok);
  });
});

describe("retry and timeout defaults", () => {
  it("fills them in for git and shell actions", () => {
    const result = validateRuleInput({ ...base, actions: [{ type: "git", command: "fetch" }, { type: "shell", command: "ls" }] });
    assert.ok(result.ok);
    const [git, shell] = result.value.actions;
    assert.deepEqual([git?.type === "git" && git.timeoutSec, git?.type === "git" && git.retries, git?.type === "git" && git.retryDelaySec], [60, 0, 5]);
    assert.deepEqual([shell?.type === "shell" && shell.timeoutSec, shell?.type === "shell" && shell.retries], [30, 0]);
  });
});
