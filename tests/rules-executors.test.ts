import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PushEvent } from "@shared/events";
import type { Project } from "@shared/projects";
import type { Rule } from "@shared/rules";
import { DEFAULT_BRANCH_TEMPLATE } from "@shared/branch-template";
import { saveBranchRule } from "@main/db/branch-rules-repo";
import { addProject, getProject } from "@main/db/projects-repo";
import { createRule, isSelfCaused } from "@main/db/rules-repo";
import type { GitResult, GitRunner } from "@main/git/run-git";
import { createNotifyExecutors, describeUrl, notificationText, webhookPayload } from "@main/rules/executors/notify";
import { createWorkBranchExecutor } from "@main/rules/executors/work-branch";
import { SecretMissingError, SecretUnreadableError } from "@main/vault/vault";
import { formatConfirmText } from "@main/rules/confirm-text";
import { createTestDb, storeEvent } from "./helpers/db";

const SLACK = "https://hooks.slack.com/services/T000/B000/abcdefghijkl";

const project = { id: 1, name: "acme/api" } as Project;
const event = {
  id: 1, projectId: 1, eventType: "push", ref: "refs/heads/main", branch: "main",
  beforeSha: "b".repeat(40), afterSha: "a".repeat(40), pusher: "alice", pusherInferred: false,
  headMessage: "feat: login", commits: [{ sha: "a".repeat(40), message: "feat: login", author: "alice", timestamp: 1 }],
  files: [{ path: "src/a.ts", status: "modified" }], fileCount: 1, branchViolation: false,
  source: "webhook", occurredAt: 5, createdAt: 5
} as unknown as PushEvent;
const rule = { id: 1, name: "r" } as Rule;
const context = { rule, event, project };

const notifySetup = (overrides: { slackUrl?: string | Error; status?: number; postError?: boolean } = {}) => {
  const shown: Array<[string, string]> = [];
  const posts: Array<{ url: string; body: unknown }> = [];
  const executors = createNotifyExecutors({
    showNotification: (title, body) => void shown.push([title, body]),
    post: async (url, body) => {
      if (overrides.postError) throw new Error(`connect failed ${url}`);
      posts.push({ url, body });
      return { status: overrides.status ?? 200 };
    },
    withSlackUrl: async (fn) => {
      const url = overrides.slackUrl ?? SLACK;
      if (url instanceof Error) throw url;
      return fn(url);
    }
  });
  return { executors, shown, posts };
};

describe("notify_system", () => {
  it("uses the default notification text, or the user's template with variables", async () => {
    const t = notifySetup();
    const result = await t.executors.notify_system!.run({ type: "notify_system" }, context);
    assert.equal(result.status, "success");
    assert.deepEqual(t.shown[0], ["acme/api · main", "alice：feat: login"]);

    await t.executors.notify_system!.run({ type: "notify_system", title: "Push to {branch}", body: "{pusher}: {message}" }, context);
    assert.deepEqual(t.shown[1], ["Push to main", "alice: feat: login"]);
  });

  it("describes without showing anything", async () => {
    const t = notifySetup();
    const text = await t.executors.notify_system!.describe({ type: "notify_system" }, context);
    assert.match(text, /acme\/api · main/);
    assert.equal(t.shown.length, 0);
  });
});

describe("notify_slack", () => {
  it("posts the message to the stored webhook URL", async () => {
    const t = notifySetup();
    const result = await t.executors.notify_slack!.run({ type: "notify_slack" }, context);
    assert.equal(result.status, "success");
    assert.equal(t.posts[0]?.url, SLACK);
    assert.match(JSON.stringify(t.posts[0]?.body), /acme\/api · main/);
  });

  it("uses custom text with variables", async () => {
    const t = notifySetup();
    await t.executors.notify_slack!.run({ type: "notify_slack", text: "{project} got {commits} commit(s)" }, context);
    assert.deepEqual(t.posts[0]?.body, { text: "acme/api got 1 commit(s)" });
  });

  it("refuses a URL that is not a Slack webhook (e.g. a tampered vault entry)", async () => {
    const t = notifySetup({ slackUrl: "https://evil.example.com/collect" });
    const result = await t.executors.notify_slack!.run({ type: "notify_slack" }, context);
    assert.equal(result.status, "failed");
    assert.equal(t.posts.length, 0);
  });

  it("explains a missing or unreadable webhook and never echoes the URL on failure", async () => {
    assert.match((await notifySetup({ slackUrl: new SecretMissingError("notify.slack_webhook") }).executors.notify_slack!.run({ type: "notify_slack" }, context)).message, /尚未設定/);
    assert.match((await notifySetup({ slackUrl: new SecretUnreadableError("notify.slack_webhook") }).executors.notify_slack!.run({ type: "notify_slack" }, context)).message, /重新輸入/);

    const down = await notifySetup({ postError: true }).executors.notify_slack!.run({ type: "notify_slack" }, context);
    assert.equal(down.status, "failed");
    assert.ok(!JSON.stringify(down).includes("abcdefghijkl"));

    const rejected = await notifySetup({ status: 404 }).executors.notify_slack!.run({ type: "notify_slack" }, context);
    assert.match(rejected.message, /404/);
  });

  it("the confirmation text never contains the webhook URL", async () => {
    const text = await notifySetup().executors.notify_slack!.describe({ type: "notify_slack" }, context);
    assert.ok(!text.includes("abcdefghijkl"));
  });
});

describe("notify_webhook", () => {
  it("posts an event summary to the configured URL", async () => {
    const t = notifySetup();
    const result = await t.executors.notify_webhook!.run({ type: "notify_webhook", url: "https://example.com/hook?token=abc", includeEvent: true }, context);

    assert.equal(result.status, "success");
    assert.equal(t.posts[0]?.url, "https://example.com/hook?token=abc");
    const body = t.posts[0]?.body as { source: string; event: { commits: unknown[]; files: unknown[]; afterSha: string } };
    assert.equal(body.source, "gitnrun");
    assert.equal(body.event.afterSha, event.afterSha);
    assert.equal(body.event.files.length, 1);
  });

  it("can send just the project and branch", () => {
    assert.deepEqual(webhookPayload(event, project, false), { source: "gitnrun", project: "acme/api", branch: "main", type: "push" });
  });

  it("only allows plain http(s) URLs without embedded credentials", async () => {
    const t = notifySetup();
    for (const url of ["ftp://example.com/x", "file:///etc/passwd", "javascript:alert(1)", "https://user:pass@example.com/x", "not a url"]) {
      const result = await t.executors.notify_webhook!.run({ type: "notify_webhook", url, includeEvent: true }, context);
      assert.equal(result.status, "failed", url);
    }
    assert.equal(t.posts.length, 0);
  });

  it("shows only origin and path in the confirmation text — the query string may hold a credential", async () => {
    const t = notifySetup();
    const text = await t.executors.notify_webhook!.describe({ type: "notify_webhook", url: "https://example.com/hook?key=SUPERSECRET", includeEvent: true }, context);
    assert.match(text, /https:\/\/example\.com\/hook/);
    assert.ok(!text.includes("SUPERSECRET"));
    assert.equal(describeUrl("https://example.com/a?b=c#d"), "https://example.com/a");
    assert.equal(describeUrl("garbage"), "（網址格式不正確）");
  });

  it("reports failures without leaking the URL", async () => {
    const result = await notifySetup({ postError: true }).executors.notify_webhook!.run({ type: "notify_webhook", url: "https://example.com/hook?key=SUPERSECRET", includeEvent: true }, context);
    assert.equal(result.status, "failed");
    assert.ok(!JSON.stringify(result).includes("SUPERSECRET"));
    assert.equal((await notifySetup({ status: 500 }).executors.notify_webhook!.run({ type: "notify_webhook", url: "https://example.com/x", includeEvent: true }, context)).status, "failed");
  });
});

describe("notificationText", () => {
  it("falls back to the default when a field is empty", () => {
    assert.deepEqual(notificationText({}, event, project), { title: "acme/api · main", body: "alice：feat: login" });
    assert.deepEqual(notificationText({ title: "T" }, event, project), { title: "T", body: "alice：feat: login" });
  });
});

describe("create_work_branch executor", () => {
  const gitFor = (handler: (key: string) => Partial<GitResult> | undefined = () => undefined) => {
    const calls: string[] = [];
    const runGit: GitRunner = async (_cwd, args) => {
      const key = args.join(" ");
      calls.push(key);
      const defaults: Partial<GitResult> =
        key === "rev-parse --is-inside-work-tree" ? { stdout: "true\n" }
        : key === "remote get-url origin" ? { stdout: "git@github.com:a/b.git\n" }
        : key === "rev-parse HEAD" ? { stdout: `${"f".repeat(40)}\n` }
        : key.startsWith("show-ref") ? { code: 1 }
        : key.startsWith("ls-remote") ? { code: 2 }
        : {};
      return { code: 0, stdout: "", stderr: "", timedOut: false, ...defaults, ...handler(key) };
    };
    return { calls, runGit };
  };

  const build = (handler?: (key: string) => Partial<GitResult> | undefined) => {
    const db = createTestDb();
    const added = addProject(db, {
      owner: "acme", repo: "api", name: "acme/api", localPath: "/Users/me/api",
      branchFilter: ["*"], pollIntervalSec: 30, mode: "poll", enabled: true, aiEnabled: false
    });
    db.prepare("UPDATE projects SET default_branch = 'main' WHERE id = ?").run(added.id);
    const stored = getProject(db, added.id)!;
    const triggering = storeEvent(db, stored.id, { headMessage: "feat: x" });
    const createdRule = createRule(db, {
      name: "start", enabled: true, priority: 1, matchMode: "all", conditions: [],
      actions: [{ type: "create_work_branch" }], cooldownSec: 0, skipConfirm: false
    });
    const git = gitFor(handler);
    const executor = createWorkBranchExecutor({
      db,
      git: { runGit: git.runGit, readVersion: async () => "0.1.0", now: () => new Date(2026, 9, 9) },
      now: () => 777
    }).create_work_branch!;
    return { db, git, executor, ctx: { rule: createdRule, event: triggering, project: stored } };
  };

  it("describes exactly which branch it would create, without running anything that changes state", async () => {
    const t = build();
    const text = await t.executor.describe({ type: "create_work_branch" }, t.ctx);
    assert.match(text, /v010_2026_1009/);
    assert.match(text, /git push -u origin v010_2026_1009/);
    assert.ok(!t.git.calls.some((call) => /^(fetch|checkout|pull|push)/.test(call)));
  });

  it("creates the branch and remembers the new head so this rule will not react to its own push", async () => {
    const t = build();
    const result = await t.executor.run({ type: "create_work_branch" }, t.ctx);

    assert.equal(result.status, "success");
    assert.match(result.message, /v010_2026_1009/);
    assert.deepEqual(t.git.calls.filter((call) => /^(fetch|checkout|pull|push)/.test(call)), [
      "fetch origin", "checkout main", "pull --ff-only origin main", "checkout -b v010_2026_1009", "push -u origin v010_2026_1009"
    ]);
    assert.equal(isSelfCaused(t.db, t.ctx.rule.id, ["f".repeat(40)]), true);
  });

  it("reports why it could not start, and changes nothing", async () => {
    const t = build((key) => (key === "status --porcelain" ? { stdout: " M a.ts\n" } : undefined));
    const result = await t.executor.run({ type: "create_work_branch" }, t.ctx);
    assert.equal(result.status, "failed");
    assert.match(result.message, /未提交/);
    assert.ok(!t.git.calls.some((call) => /^(fetch|checkout|pull|push)/.test(call)));
  });

  it("does not record a self-caused SHA when the push failed", async () => {
    const t = build((key) => (key.startsWith("push") ? { code: 1, stderr: "rejected" } : undefined));
    const result = await t.executor.run({ type: "create_work_branch" }, t.ctx);
    assert.equal(result.status, "failed");
    assert.equal(isSelfCaused(t.db, t.ctx.rule.id, ["f".repeat(40)]), false);
  });

  it("builds a slug from event variables, sanitised, for templates that need one", async () => {
    const t = build();
    saveBranchRule(t.db, 0, { template: "followup/{slug}-{mmdd}", versionSource: "package.json", exempt: [] });
    const text = await t.executor.describe({ type: "create_work_branch", slug: "after {branch} by {pusher}" }, t.ctx);
    assert.match(text, /followup\/after-main-by-octocat-1009/);
  });

  it("uses whatever branch rule is effective for the project", async () => {
    const t = build();
    saveBranchRule(t.db, t.ctx.project.id, { template: "wip/{mmdd}", versionSource: "package.json", exempt: [] });
    assert.match(await t.executor.describe({ type: "create_work_branch" }, t.ctx), /wip\/1009/);
    assert.equal(DEFAULT_BRANCH_TEMPLATE.includes("version"), true);
  });
});

describe("formatConfirmText", () => {
  const request = {
    ruleName: "deploy", projectName: "acme/api", branch: "main", pusher: "alice",
    headMessage: "feat: login", actionType: "shell" as const, summary: "zsh -c: echo hi\n工作目錄：/Users/me/api"
  };

  it("shows what will run, where it came from, and a reminder that event text is only data", () => {
    const { message, detail } = formatConfirmText(request);
    assert.match(message, /deploy/);
    assert.match(message, /自訂終端機指令/);
    assert.match(detail, /echo hi/);
    assert.match(detail, /acme\/api 的 main/);
    assert.match(detail, /alice/);
    assert.match(detail, /只作為資料使用/);
  });

  it("copes with a missing pusher and empty message", () => {
    const { detail } = formatConfirmText({ ...request, pusher: null, headMessage: "" });
    assert.match(detail, /推送者：（未知）/);
    assert.match(detail, /訊息：（無）/);
  });
});
