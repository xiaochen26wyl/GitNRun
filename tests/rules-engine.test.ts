import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConfirmDecision, ConfirmRequest } from "@shared/rule-runs";
import type { RuleAction, RuleInput } from "@shared/rules";
import { addProject, getProject } from "@main/db/projects-repo";
import { listExecutions, markInterruptedExecutions } from "@main/db/rule-executions-repo";
import { createRule, recordSelfSha } from "@main/db/rules-repo";
import type { LogEntry } from "@main/logger";
import { createRuleEngine, type ActionExecutors, type ActionResult } from "@main/rules/engine";
import { createTestDb, storeEvent } from "./helpers/db";

const SECRET = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

const ruleInput = (overrides: Partial<RuleInput> = {}): RuleInput => ({
  name: "rule",
  enabled: true,
  priority: 100,
  matchMode: "all",
  conditions: [],
  actions: [{ type: "notify_system" }],
  cooldownSec: 0,
  skipConfirm: false,
  ...overrides
});

const shell = (command = "echo hi", extra: Partial<RuleAction> = {}): RuleAction =>
  ({ type: "shell", command, timeoutSec: 30, env: [], secretEnvNames: [], ...extra }) as RuleAction;

const setup = (options: { decisions?: ConfirmDecision[]; results?: Partial<Record<string, ActionResult | Error>>; maxRunsPerHour?: number } = {}) => {
  const db = createTestDb();
  const project = addProject(db, {
    owner: "acme", repo: "api", name: "acme/api", localPath: null,
    branchFilter: ["*"], pollIntervalSec: 30, mode: "poll", enabled: true, aiEnabled: false
  });
  const calls: string[] = [];
  const described: string[] = [];
  const requests: ConfirmRequest[] = [];
  const logs: LogEntry[] = [];
  const decisions = [...(options.decisions ?? [])];
  let clock = 1_000_000;

  const makeExecutor = (type: string) => ({
    describe: () => {
      described.push(type);
      return `will run ${type}`;
    },
    run: async (action: RuleAction): Promise<ActionResult> => {
      const outcome = options.results?.[type];
      calls.push(`${type}${"command" in action ? `:${action.command}` : ""}`);
      if (outcome instanceof Error) throw outcome;
      return outcome ?? { status: "success", message: "ok" };
    }
  });

  const executors = {
    notify_system: makeExecutor("notify_system"),
    notify_slack: makeExecutor("notify_slack"),
    shell: makeExecutor("shell"),
    git: makeExecutor("git")
  } as unknown as ActionExecutors;

  const engine = createRuleEngine({
    db,
    now: () => clock,
    executors,
    confirm: async (request) => {
      requests.push(request);
      return decisions.shift() ?? "deny";
    },
    log: (entry) => logs.push(entry),
    maxRunsPerHour: options.maxRunsPerHour
  });

  return {
    db, project: getProject(db, project.id)!, engine, calls, described, requests, logs,
    advance: (ms: number) => (clock += ms),
    event: (overrides = {}) => storeEvent(db, project.id, overrides)
  };
};

describe("matching and read-only actions", () => {
  it("runs a matching rule's read-only action without asking", async () => {
    const t = setup();
    createRule(t.db, ruleInput({ conditions: [{ type: "branch", patterns: ["main"] }] }));

    const reports = await t.engine.runForEvent(t.event(), t.project);

    assert.deepEqual(t.calls, ["notify_system"]);
    assert.equal(t.requests.length, 0);
    assert.equal(reports[0]?.status, "success");
  });

  it("does nothing for a rule whose conditions do not match, and for disabled rules", async () => {
    const t = setup();
    createRule(t.db, ruleInput({ conditions: [{ type: "branch", patterns: ["release/*"] }] }));
    createRule(t.db, ruleInput({ name: "off", enabled: false }));

    const reports = await t.engine.runForEvent(t.event(), t.project);

    assert.deepEqual(t.calls, []);
    assert.deepEqual(reports, []);
  });

  it("runs rules in ascending priority, then by creation order", async () => {
    const t = setup();
    createRule(t.db, ruleInput({ name: "c", priority: 30, actions: [{ type: "notify_slack" }] }));
    createRule(t.db, ruleInput({ name: "a", priority: 10, actions: [{ type: "notify_system" }] }));
    createRule(t.db, ruleInput({ name: "b1", priority: 20, actions: [{ type: "notify_system" }] }));
    createRule(t.db, ruleInput({ name: "b2", priority: 20, actions: [{ type: "notify_slack" }] }));

    const reports = await t.engine.runForEvent(t.event(), t.project);

    assert.deepEqual(reports.map((report) => report.ruleName), ["a", "b1", "b2", "c"]);
  });
});

describe("confirmation gate for write actions", () => {
  it("asks first, shows what will run, and runs only after an explicit allow", async () => {
    const t = setup({ decisions: ["allow"] });
    createRule(t.db, ruleInput({ actions: [shell("git pull")] }));

    const reports = await t.engine.runForEvent(t.event({ headMessage: "feat: x", pusher: "alice" }), t.project);

    assert.equal(t.requests.length, 1);
    assert.equal(t.requests[0]?.summary, "will run shell");
    assert.equal(t.requests[0]?.projectName, "acme/api");
    assert.equal(t.requests[0]?.pusher, "alice");
    assert.deepEqual(t.calls, ["shell:git pull"]);
    assert.equal(reports[0]?.status, "success");
  });

  it("does not run a declined action and stops the rule", async () => {
    const t = setup({ decisions: ["deny"] });
    createRule(t.db, ruleInput({ actions: [shell("rm -rf build"), { type: "notify_system" }] }));

    const [report] = await t.engine.runForEvent(t.event(), t.project);

    assert.deepEqual(t.calls, []);
    assert.equal(report?.status, "declined");
    assert.equal(report?.actions.length, 1, "later actions do not run after a decline");
  });

  it("treats a confirmation timeout as 'skipped and recorded'", async () => {
    const t = setup({ decisions: ["timeout"] });
    createRule(t.db, ruleInput({ actions: [shell()] }));

    const [report] = await t.engine.runForEvent(t.event(), t.project);

    assert.deepEqual(t.calls, []);
    assert.equal(report?.status, "timeout");
    assert.equal(report?.actions[0]?.status, "timeout");
  });

  it("'skip confirmation' runs write actions straight away", async () => {
    const t = setup();
    createRule(t.db, ruleInput({ skipConfirm: true, actions: [shell("make build")] }));

    await t.engine.runForEvent(t.event(), t.project);

    assert.equal(t.requests.length, 0);
    assert.deepEqual(t.calls, ["shell:make build"]);
  });

  it("asks per action: read-only ones in the same rule never prompt", async () => {
    const t = setup({ decisions: ["allow"] });
    createRule(t.db, ruleInput({ actions: [{ type: "notify_system" }, shell("echo 1"), { type: "notify_slack" }] }));

    await t.engine.runForEvent(t.event(), t.project);

    assert.equal(t.requests.length, 1);
    assert.deepEqual(t.calls, ["notify_system", "shell:echo 1", "notify_slack"]);
  });

  it("the default answer when nobody responds is no", async () => {
    const t = setup(); // 沒有任何預先給定的決定 → 假的 confirm 回 deny
    createRule(t.db, ruleInput({ actions: [shell()] }));
    await t.engine.runForEvent(t.event(), t.project);
    assert.deepEqual(t.calls, []);
  });
});

describe("failure handling", () => {
  it("stops after a failed action by default", async () => {
    const t = setup({ results: { notify_system: { status: "failed", message: "boom" } } });
    createRule(t.db, ruleInput({ actions: [{ type: "notify_system" }, { type: "notify_slack" }] }));

    const [report] = await t.engine.runForEvent(t.event(), t.project);

    assert.deepEqual(t.calls, ["notify_system"]);
    assert.equal(report?.status, "failed");
  });

  it("continues past a failure only when the action says so, but still reports failure", async () => {
    const t = setup({ results: { notify_system: { status: "failed", message: "boom" } } });
    createRule(t.db, ruleInput({ actions: [{ type: "notify_system", continueOnFailure: true }, { type: "notify_slack" }] }));

    const [report] = await t.engine.runForEvent(t.event(), t.project);

    assert.deepEqual(t.calls, ["notify_system", "notify_slack"]);
    assert.equal(report?.status, "failed");
  });

  it("a declined action can also be skipped over with continueOnFailure", async () => {
    const t = setup({ decisions: ["deny"] });
    createRule(t.db, ruleInput({ actions: [{ ...shell(), continueOnFailure: true }, { type: "notify_system" }] }));

    const [report] = await t.engine.runForEvent(t.event(), t.project);

    assert.deepEqual(t.calls, ["notify_system"]);
    assert.equal(report?.status, "declined");
  });

  it("an action type with no executor is reported as unsupported (a failure), not silently ignored", async () => {
    const t = setup();
    createRule(t.db, ruleInput({ actions: [{ type: "notify_email", to: "a@b.co" }] }));

    const [report] = await t.engine.runForEvent(t.event(), t.project);

    assert.equal(report?.status, "failed");
    assert.equal(report?.actions[0]?.status, "unsupported");
  });

  it("never leaks an executor's thrown error text into reports, executions or logs", async () => {
    const t = setup({ results: { notify_system: new Error(`failed with token ${SECRET}`) } });
    createRule(t.db, ruleInput({ actions: [{ type: "notify_system" }] }));

    const [report] = await t.engine.runForEvent(t.event(), t.project);

    assert.equal(report?.status, "failed");
    const everything = JSON.stringify([report, listExecutions(t.db), t.logs]);
    assert.ok(!everything.includes(SECRET));
  });
});

describe("loop prevention and limits", () => {
  it("a rule ignores pushes it caused itself, but other rules still run", async () => {
    const t = setup();
    const mine = createRule(t.db, ruleInput({ name: "mine" }));
    createRule(t.db, ruleInput({ name: "other" }));
    const event = t.event();
    recordSelfSha(t.db, mine.id, event.afterSha);

    const reports = await t.engine.runForEvent(event, t.project);

    assert.deepEqual(reports.map((report) => report.ruleName), ["other"]);
    assert.ok(t.logs.some((entry) => entry.message.includes("自己造成")));
  });

  it("recognises its own push by any commit in the event, not just the head", async () => {
    const t = setup();
    const mine = createRule(t.db, ruleInput());
    const commitSha = "c".repeat(40);
    recordSelfSha(t.db, mine.id, commitSha);
    const event = t.event({ commits: [{ sha: commitSha, message: "x", author: "me", timestamp: 0 }] });

    assert.deepEqual(await t.engine.runForEvent(event, t.project), []);
  });

  it("enforces a cooldown per rule, project and branch", async () => {
    const t = setup();
    createRule(t.db, ruleInput({ cooldownSec: 60 }));

    assert.equal((await t.engine.runForEvent(t.event(), t.project)).length, 1);

    t.advance(30_000);
    assert.equal((await t.engine.runForEvent(t.event(), t.project)).length, 0, "same branch inside the cooldown");

    const otherBranch = t.event({ branch: "dev", ref: "refs/heads/dev" });
    assert.equal((await t.engine.runForEvent(otherBranch, t.project)).length, 1, "a different branch is independent");

    t.advance(31_000);
    assert.equal((await t.engine.runForEvent(t.event(), t.project)).length, 1, "after the cooldown it runs again");
  });

  it("stops a runaway rule at the hourly cap", async () => {
    const t = setup({ maxRunsPerHour: 3 });
    createRule(t.db, ruleInput());

    let runs = 0;
    for (let i = 0; i < 6; i += 1) {
      runs += (await t.engine.runForEvent(t.event(), t.project)).length;
    }

    assert.equal(runs, 3);
    assert.ok(t.logs.some((entry) => entry.message.includes("上限")));

    t.advance(61 * 60 * 1000);
    assert.equal((await t.engine.runForEvent(t.event(), t.project)).length, 1, "the window slides");
  });
});

describe("execution history", () => {
  it("records each run with its action reports", async () => {
    const t = setup({ decisions: ["allow"] });
    const rule = createRule(t.db, ruleInput({ name: "recorded", actions: [{ type: "notify_system" }, shell("ls")] }));
    const event = t.event();

    await t.engine.runForEvent(event, t.project);

    const [execution] = listExecutions(t.db, { ruleId: rule.id });
    assert.equal(execution?.status, "success");
    assert.equal(execution?.eventId, event.id);
    assert.equal(execution?.ruleName, "recorded");
    assert.deepEqual(execution?.actions.map((action) => [action.type, action.write, action.status]), [
      ["notify_system", false, "success"],
      ["shell", true, "success"]
    ]);
    assert.ok((execution?.finishedAt ?? 0) >= (execution?.startedAt ?? 1));
  });

  it("marks runs that were cut off by quitting the app as interrupted", () => {
    const t = setup();
    const rule = createRule(t.db, ruleInput());
    const event = t.event();
    t.db.prepare("INSERT INTO rule_executions (rule_id, rule_name, event_id, status, started_at) VALUES (?, 'r', ?, 'running', 1)").run(rule.id, event.id);

    assert.equal(markInterruptedExecutions(t.db, 99), 1);
    assert.equal(listExecutions(t.db)[0]?.status, "interrupted");
    assert.equal(markInterruptedExecutions(t.db, 100), 0);
  });
});

describe("queue", () => {
  it("enqueue returns immediately and events are processed in order, one at a time", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const t = setup({ decisions: ["allow", "allow"] });
    createRule(t.db, ruleInput({ actions: [shell("first")] }));
    // 第一次確認要等 gate，期間第二個事件只能排隊。
    const engine = createRuleEngine({
      db: t.db,
      now: () => 1,
      executors: {
        shell: {
          describe: () => "shell",
          run: async (action: RuleAction) => {
            order.push(`run:${(action as { command: string }).command}`);
            return { status: "success", message: "ok" };
          }
        }
      } as unknown as ActionExecutors,
      confirm: async (request) => {
        order.push(`confirm:${request.branch}`);
        if (request.branch === "one") await gate;
        return "allow";
      },
      log: () => undefined
    });

    engine.enqueue(t.event({ branch: "one", ref: "refs/heads/one" }), t.project);
    engine.enqueue(t.event({ branch: "two", ref: "refs/heads/two" }), t.project);
    assert.deepEqual(order, [], "nothing blocks the caller");

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ["confirm:one"], "the second event waits for the first");

    release();
    await engine.idle();
    assert.deepEqual(order, ["confirm:one", "run:first", "confirm:two", "run:first"]);
  });

  it("one failing event does not stop later events", async () => {
    const t = setup();
    createRule(t.db, ruleInput());
    t.db.exec("DROP TABLE rule_self_events"); // 讓第一次處理丟出未預期的例外
    t.engine.enqueue(t.event(), t.project);
    await t.engine.idle();
    assert.ok(t.logs.some((entry) => entry.level === "error"));
  });
});

describe("dry run and preview", () => {
  it("evaluates conditions and describes actions without running or confirming anything", async () => {
    const t = setup();
    const event = t.event({ branch: "main" });
    const report = await t.engine.dryRun(
      ruleInput({
        conditions: [{ type: "branch", patterns: ["main"] }, { type: "file_count", op: "gte", value: 5 }],
        actions: [{ type: "notify_system" }, shell("deploy.sh"), { type: "notify_email", to: "a@b.co" }]
      }),
      event,
      t.project
    );

    assert.equal(report.matched, false);
    assert.deepEqual(report.conditions, [{ type: "branch", matched: true }, { type: "file_count", matched: false }]);
    assert.deepEqual(report.actions.map((action) => [action.type, action.write, action.requiresConfirmation]), [
      ["notify_system", false, false],
      ["shell", true, true],
      ["notify_email", true, true]
    ]);
    assert.equal(report.actions[1]?.summary, "will run shell");
    assert.match(report.actions[2]?.summary ?? "", /尚未支援/);
    assert.deepEqual(t.calls, [], "no action ran");
    assert.equal(t.requests.length, 0, "nobody was asked");
    assert.equal(listExecutions(t.db).length, 0, "nothing was recorded as an execution");
  });

  it("reflects 'skip confirmation' in the dry run", async () => {
    const t = setup();
    const report = await t.engine.dryRun(ruleInput({ skipConfirm: true, actions: [shell()] }), t.event(), t.project);
    assert.equal(report.actions[0]?.requiresConfirmation, false);
  });

  it("previews which historical events a rule would hit", () => {
    const t = setup();
    const a = t.event({ branch: "main", ref: "refs/heads/main" });
    t.event({ branch: "dev", ref: "refs/heads/dev" });
    const c = t.event({ branch: "main", ref: "refs/heads/main" });

    const preview = t.engine.previewMatches(ruleInput({ conditions: [{ type: "branch", patterns: ["main"] }] }));

    assert.equal(preview.examined, 3);
    assert.deepEqual([...preview.matchedEventIds].sort(), [a.id, c.id].sort());
  });
});
