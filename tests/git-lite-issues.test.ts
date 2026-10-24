import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ISSUE_PREVIEW_COUNT,
  PUSH_REMINDER_THRESHOLD,
  feedAfterFailure,
  feedForMode,
  findGitLiteProject,
  formatGroupIssueTotal,
  isIssueSkippedFolder,
  isIssueSkippedGroup,
  issueCountLabel,
  parseIssueDisplayPref,
  planChangeBadge,
  planIssueSection,
  serializeIssueDisplayPref,
  summarizeIssueGroup,
  type GitLiteIssue,
  type GitLiteIssueErrorKind,
  type GitLiteOverview,
  type FeedState,
  type GitLiteProject,
  type IssueFeed
} from "@shared/git-lite";

const issue = (number: number): GitLiteIssue => ({
  id: number,
  number,
  title: `Issue ${number}`,
  url: `https://github.com/acme/widgets/issues/${number}`,
  author: "octo",
  updatedAt: 1
});

const project = (folder: string, overrides: Partial<GitLiteProject> = {}): GitLiteProject => ({
  id: folder,
  label: folder.split("/").pop() ?? folder,
  folder,
  source: "folder",
  isGitRepo: true,
  branch: "main",
  upstream: null,
  ahead: 0,
  behind: 0,
  changedFiles: 0,
  stagedFiles: 0,
  unstagedFiles: 0,
  untrackedFiles: 0,
  repo: { owner: "acme", repo: "widgets", url: "https://github.com/acme/widgets" },
  issues: [],
  issuesTruncated: false,
  statusError: null,
  issueError: null,
  issueErrorKind: null,
  ...overrides
});

const withIssues = (folder: string, count: number, overrides: Partial<GitLiteProject> = {}): GitLiteProject =>
  project(folder, { issues: Array.from({ length: count }, (_, index) => issue(count - index)), ...overrides });

const ready = (...projects: GitLiteProject[]): IssueFeed => ({
  status: "ready",
  overview: { githubTokenConfigured: true, projects } satisfies GitLiteOverview
});

describe("findGitLiteProject", () => {
  it("matches a folder regardless of a trailing slash on either side", () => {
    const overview: GitLiteOverview = { githubTokenConfigured: true, projects: [project("/work/app"), project("/work/lib/")] };
    assert.equal(findGitLiteProject(overview, "/work/app/")?.folder, "/work/app");
    assert.equal(findGitLiteProject(overview, "/work/lib")?.folder, "/work/lib/");
    assert.equal(findGitLiteProject(overview, "/work/other"), null);
  });
});

describe("planIssueSection states", () => {
  it("reports loading and a failed read before looking at any project", () => {
    assert.deepEqual(planIssueSection({ status: "loading" }, "/work/app", false), { kind: "loading" });
    assert.deepEqual(planIssueSection({ status: "failed", message: "boom" }, "/work/app", false), {
      kind: "error",
      message: "boom",
      action: "retry"
    });
  });

  it("hides the section for folders that are not git repos or are unknown", () => {
    const feed = ready(project("/work/plain", { isGitRepo: false, repo: null }));
    assert.deepEqual(planIssueSection(feed, "/work/plain", false), { kind: "hidden" });
    assert.deepEqual(planIssueSection(feed, "/work/missing", false), { kind: "hidden" });
  });

  it("says so when origin is not a GitHub remote", () => {
    const feed = ready(project("/work/app", { repo: null }));
    assert.deepEqual(planIssueSection(feed, "/work/app", false), { kind: "no-github" });
  });

  it("keeps the handler's message and picks the action from the error kind", () => {
    const cases: Array<[GitLiteIssueErrorKind, string, unknown]> = [
      ["token-rejected", "GitHub token 無法讀取 issues", "settings"],
      ["not-found", "找不到 GitHub repo 或沒有權限", null],
      ["network", "無法連線到 GitHub", "retry"],
      ["http", "GitHub 回應 HTTP 500", "retry"]
    ];
    for (const [kind, message, action] of cases) {
      const feed = ready(project("/work/app", { issueError: message, issueErrorKind: kind }));
      assert.deepEqual(planIssueSection(feed, "/work/app", false), { kind: "error", message, action }, kind);
    }
  });

  it("treats a missing or unreadable token as its own state", () => {
    const feed = ready(project("/work/app", { issueError: "尚未設定 GitHub token", issueErrorKind: "no-token" }));
    assert.deepEqual(planIssueSection(feed, "/work/app", false), { kind: "no-token", message: "尚未設定 GitHub token" });
  });

  it("reports an empty list with a zero count", () => {
    const plan = planIssueSection(ready(project("/work/app")), "/work/app", false);
    assert.equal(plan.kind, "empty");
    assert.equal(plan.kind === "empty" ? plan.countLabel : "", "0 open");
  });
});

describe("planIssueSection preview and expansion", () => {
  const listPlan = (count: number, expanded: boolean, truncated = false) => {
    const plan = planIssueSection(ready(withIssues("/work/app", count, { issuesTruncated: truncated })), "/work/app", expanded);
    assert.equal(plan.kind, "list");
    if (plan.kind !== "list") throw new Error("expected a list plan");
    return plan;
  };

  it("shows everything with no expand button at exactly the preview size", () => {
    const plan = listPlan(ISSUE_PREVIEW_COUNT, false);
    assert.equal(plan.visible.length, ISSUE_PREVIEW_COUNT);
    assert.equal(plan.hiddenCount, 0);
  });

  it("collapses to the preview size and counts the hidden rows from one past it", () => {
    const plan = listPlan(ISSUE_PREVIEW_COUNT + 1, false);
    assert.equal(plan.visible.length, ISSUE_PREVIEW_COUNT);
    assert.equal(plan.hiddenCount, 1);
  });

  it("expands to every row and keeps GitHub's order", () => {
    const plan = listPlan(12, true);
    assert.equal(plan.visible.length, 12);
    assert.equal(plan.hiddenCount, 7);
    assert.deepEqual(plan.visible.slice(0, 3).map((item) => item.number), [12, 11, 10]);
  });

  it("handles the 20-row cap", () => {
    const plan = listPlan(20, false, true);
    assert.equal(plan.visible.length, ISSUE_PREVIEW_COUNT);
    assert.equal(plan.hiddenCount, 15);
    assert.equal(plan.truncated, true);
    assert.equal(plan.countLabel, "20+ open");
  });
});

describe("issueCountLabel", () => {
  it("adds a plus only when the list was truncated", () => {
    assert.equal(issueCountLabel(12, false), "12 open");
    assert.equal(issueCountLabel(17, true), "17+ open");
    assert.equal(issueCountLabel(0, false), "0 open");
  });
});

describe("summarizeIssueGroup", () => {
  it("counts every project but reports no issue total until the data is ready", () => {
    const folders = ["/work/a", "/work/b", "/work/c"];
    assert.deepEqual(summarizeIssueGroup({ status: "loading" }, folders), { projectCount: 3, openIssues: null });
    assert.deepEqual(summarizeIssueGroup({ status: "failed", message: "x" }, folders), { projectCount: 3, openIssues: null });
  });

  it("sums the projects that loaded and adds a plus when any one is truncated", () => {
    const folders = ["/work/a", "/work/b", "/work/c"];
    const feed = ready(withIssues("/work/a", 12), withIssues("/work/b", 2), project("/work/c"));
    assert.deepEqual(summarizeIssueGroup(feed, folders).openIssues, { count: 14, truncated: false });

    const capped = ready(withIssues("/work/a", 20, { issuesTruncated: true }), withIssues("/work/b", 2));
    const summary = summarizeIssueGroup(capped, folders);
    assert.deepEqual(summary.openIssues, { count: 22, truncated: true });
    assert.equal(formatGroupIssueTotal(summary.openIssues ?? { count: 0, truncated: false }), "22+ 筆 open issues");
    assert.equal(formatGroupIssueTotal({ count: 12, truncated: false }), "12 筆 open issues");
  });

  it("leaves out projects that errored, are not on GitHub, or are missing", () => {
    const folders = ["/work/a", "/work/b", "/work/c", "/work/d"];
    const feed = ready(
      withIssues("/work/a", 3),
      withIssues("/work/b", 0, { issueError: "x", issueErrorKind: "network" }),
      project("/work/c", { repo: null })
    );
    assert.deepEqual(summarizeIssueGroup(feed, folders), { projectCount: 4, openIssues: { count: 3, truncated: false } });
  });

  it("reports no total when nothing loaded successfully", () => {
    const feed = ready(project("/work/a", { issueError: "x", issueErrorKind: "no-token" }));
    assert.equal(summarizeIssueGroup(feed, ["/work/a", "/work/b"]).openIssues, null);
  });
});

describe("projects that do not read issues", () => {
  it("skips the Free (open-source) group only", () => {
    assert.equal(isIssueSkippedGroup("open-source"), true);
    for (const id of ["saas", "creator", "someday", "other"] as const) {
      assert.equal(isIssueSkippedGroup(id), false, id);
    }
  });

  it("follows the group table: every project in those groups is skipped, others are not", () => {
    for (const folder of ["/Users/me/GitHub/Usage-Pulse", "/Users/me/GitHub/GitNRun", "/Users/me/GitHub/gitnrun/", "/work/SOCIALHUB"]) {
      assert.equal(isIssueSkippedFolder(folder), true, folder);
    }
    for (const folder of ["/work/stockPaw", "/work/toBloom", "/work/fictionPurr", "/work/yumeAegis", "/work/app", "/work/GitNRun-docs", "/work/GitNRun/sub", ""]) {
      assert.equal(isIssueSkippedFolder(folder), false, folder);
    }
  });

  it("hides the section no matter what the feed says", () => {
    const folder = "/work/GitNRun";
    assert.deepEqual(planIssueSection({ status: "loading" }, folder, false), { kind: "hidden" });
    assert.deepEqual(planIssueSection({ status: "failed", message: "x" }, folder, false), { kind: "hidden" });
    assert.deepEqual(planIssueSection(ready(withIssues(folder, 3)), folder, true), { kind: "hidden" });
    assert.equal(planIssueSection(ready(withIssues("/work/other", 3)), "/work/other", false).kind, "list");
  });

  it("leaves it out of the group total, so it neither adds a zero nor counts as loaded", () => {
    const folders = ["/work/GitNRun", "/work/toBloom"];
    const onlyOthersFailed = ready(project("/work/GitNRun"), project("/work/toBloom", { issueError: "x", issueErrorKind: "not-found" }));
    assert.deepEqual(summarizeIssueGroup(onlyOthersFailed, folders), { projectCount: 2, openIssues: null });

    const othersLoaded = ready(project("/work/GitNRun"), withIssues("/work/toBloom", 4));
    assert.deepEqual(summarizeIssueGroup(othersLoaded, folders).openIssues, { count: 4, truncated: false });
  });
});

describe("issue display preference", () => {
  it("is on unless it was explicitly saved as off", () => {
    assert.equal(parseIssueDisplayPref(null), true);
    assert.equal(parseIssueDisplayPref(undefined), true);
    assert.equal(parseIssueDisplayPref("1"), true);
    assert.equal(parseIssueDisplayPref("0"), false);
    assert.equal(parseIssueDisplayPref("false"), true);
    assert.equal(parseIssueDisplayPref(""), true);
  });

  it("round-trips through the serialized form", () => {
    assert.equal(parseIssueDisplayPref(serializeIssueDisplayPref(false)), false);
    assert.equal(parseIssueDisplayPref(serializeIssueDisplayPref(true)), true);
  });
});

describe("planChangeBadge", () => {
  const badgeFor = (changedFiles: number) => planChangeBadge(ready(project("/work/app", { changedFiles })), "/work/app");

  it("uses 100 as the push reminder threshold", () => {
    assert.equal(PUSH_REMINDER_THRESHOLD, 100);
  });

  it("shows the count against the threshold without a reminder below it", () => {
    for (const count of [0, 1, 99]) {
      assert.deepEqual(badgeFor(count), { kind: "badge", count, text: `變更檔案 ${count}／100`, reminder: null }, String(count));
    }
  });

  it("adds the push reminder from exactly 100 files", () => {
    for (const count of [100, 101, 200]) {
      assert.deepEqual(
        badgeFor(count),
        { kind: "badge", count, text: `變更檔案 ${count}／100`, reminder: "已達 100，該推送了" },
        String(count)
      );
    }
  });

  it("matches the folder regardless of a trailing slash", () => {
    const feed = ready(project("/work/app/", { changedFiles: 3 }));
    assert.equal(planChangeBadge(feed, "/work/app").kind, "badge");
  });

  it("stays hidden instead of reporting a false zero", () => {
    assert.deepEqual(planChangeBadge({ status: "loading" }, "/work/app"), { kind: "hidden" });
    assert.deepEqual(planChangeBadge({ status: "failed", message: "boom" }, "/work/app"), { kind: "hidden" });
    assert.deepEqual(planChangeBadge(ready(), "/work/app"), { kind: "hidden" });
    assert.deepEqual(planChangeBadge(ready(project("/work/app", { isGitRepo: false, statusError: "不是 git repo" })), "/work/app"), {
      kind: "hidden"
    });
    assert.deepEqual(planChangeBadge(ready(project("/work/app", { statusError: "無法讀取 git 狀態" })), "/work/app"), { kind: "hidden" });
  });

  it("still shows for groups whose issues are skipped", () => {
    assert.equal(isIssueSkippedFolder("/work/GitNRun"), true);
    const feed = ready(project("/work/GitNRun", { changedFiles: 60 }));
    assert.equal(planChangeBadge(feed, "/work/GitNRun").kind, "badge");
  });
});

describe("shared feed state", () => {
  const loaded = (withIssues: boolean): FeedState => ({ feed: ready(project("/work/a")), withIssues });

  it("serves the shared data only when it was read in the requested mode", () => {
    assert.equal(feedForMode(loaded(true), true).status, "ready");
    assert.equal(feedForMode(loaded(false), false).status, "ready");
    assert.deepEqual(feedForMode(loaded(false), true), { status: "loading" });
    assert.deepEqual(feedForMode(loaded(true), false), { status: "loading" });
  });

  it("keeps existing data when a refresh fails", () => {
    const current = loaded(true);
    assert.equal(feedAfterFailure(current, "boom", true), current);
  });

  it("reports the failure when there is no data to keep", () => {
    const empty: FeedState = { feed: { status: "loading" }, withIssues: false };
    assert.deepEqual(feedAfterFailure(empty, "boom", true), { feed: { status: "failed", message: "boom" }, withIssues: true });
  });
});
