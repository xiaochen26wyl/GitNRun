import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GitLiteProject, IssueFeed } from "@shared/git-lite";
import type { RunTargetView } from "@shared/run";
import { groupRunServices } from "@shared/run";
import {
  EMPTY_RUN_ORDER,
  EMPTY_RUN_SORT_MODES,
  applySavedOrder,
  buildRunOrderEntries,
  commitRunOrder,
  entriesOfTargets,
  moveItem,
  openIssueCountOf,
  orderedRunServiceRows,
  orderedRunTargets,
  parseRunOrder,
  parseRunSortModes,
  runSortModeOf,
  serializeRunOrder,
  serializeRunSortModes,
  serviceRowName,
  sortByOpenIssues,
  withRunSortMode,
  type RunOrder
} from "@shared/run-order";

const ROOT = "/Users/zorawl/Documents/GitHub";

/** 只帶排序會用到的欄位；其餘欄位對排序沒有影響。 */
const targetOf = (name: string, serviceNames: string[] = []): RunTargetView =>
  ({ id: `p:${name}`, label: name, folder: `${ROOT}/${name}`, services: serviceNames.map((service) => ({ name: service })) }) as unknown as RunTargetView;

const idsOf = (targets: readonly { id: string }[]): string[] => targets.map((target) => target.id);
const namesOf = (rows: ReturnType<typeof groupRunServices>): string[] => rows.map((row) => serviceRowName(row));

describe("run order storage", () => {
  it("falls back to the empty order for anything that is not a valid stored order", () => {
    for (const stored of [null, undefined, "", "not json", "[]", "null", "42", '"text"']) {
      assert.deepEqual(parseRunOrder(stored), EMPTY_RUN_ORDER, String(stored));
    }
    assert.deepEqual(parseRunOrder("{}"), EMPTY_RUN_ORDER);
  });

  it("round-trips a saved order", () => {
    const order: RunOrder = { targets: { saas: ["tobloom", "stockpaw"] }, services: { fictionpurr: ["web-fictionpurr", "api"] } };
    assert.deepEqual(parseRunOrder(serializeRunOrder(order)), order);
  });

  it("drops only the broken lists and keeps the rest", () => {
    const stored = JSON.stringify({
      targets: { saas: ["a", "b"], someday: "oops", personal: ["x", 3] },
      services: { fictionpurr: ["api", "", "web"], gitnrun: ["a", "a", "b"] }
    });
    assert.deepEqual(parseRunOrder(stored), { targets: { saas: ["a", "b"] }, services: { gitnrun: ["a", "b"] } });
  });

  it("rejects lists that are too long and ignores unknown top-level fields", () => {
    const tooMany = Array.from({ length: 201 }, (_, index) => `app-${index}`);
    const stored = JSON.stringify({ targets: { saas: tooMany }, services: {}, extra: 1 });
    assert.deepEqual(parseRunOrder(stored), EMPTY_RUN_ORDER);
  });

  it("does not let a __proto__ key change the prototype of the parsed lists", () => {
    const parsed = parseRunOrder('{"targets":{"__proto__":["x"]},"services":{}}');
    assert.equal(Object.getPrototypeOf(parsed.targets), Object.prototype);
    assert.deepEqual(Object.keys(parsed.targets), ["__proto__"]);
  });
});

describe("applySavedOrder and moveItem", () => {
  const keyOf = (item: string): string => item;

  it("puts saved names first in saved order and appends the rest in their original order", () => {
    assert.deepEqual(applySavedOrder(["a", "b", "c", "d"], keyOf, ["c", "a"]), ["c", "a", "b", "d"]);
  });

  it("ignores saved names that no longer exist", () => {
    assert.deepEqual(applySavedOrder(["a", "b"], keyOf, ["gone", "b", "also-gone", "a"]), ["b", "a"]);
  });

  it("returns a copy in the original order when nothing is saved", () => {
    const items = ["a", "b"];
    const result = applySavedOrder(items, keyOf, undefined);
    assert.deepEqual(result, items);
    assert.notEqual(result, items);
  });

  it("moves an item up or down by one and stops at the edges", () => {
    assert.deepEqual(moveItem(["a", "b", "c"], 1, -1), ["b", "a", "c"]);
    assert.deepEqual(moveItem(["a", "b", "c"], 1, 1), ["a", "c", "b"]);
    assert.deepEqual(moveItem(["a", "b", "c"], 0, -1), ["a", "b", "c"]);
    assert.deepEqual(moveItem(["a", "b", "c"], 2, 1), ["a", "b", "c"]);
    assert.deepEqual(moveItem(["a", "b", "c"], 5, -1), ["a", "b", "c"]);
    assert.deepEqual(moveItem(["a", "b", "c"], -1, 1), ["a", "b", "c"]);
  });

  it("does not change the list it was given", () => {
    const items = ["a", "b", "c"];
    moveItem(items, 0, 1);
    assert.deepEqual(items, ["a", "b", "c"]);
  });
});

describe("ordered targets and service rows", () => {
  const saas = [targetOf("xiaochenStudio"), targetOf("stockPaw"), targetOf("toBloom")];

  it("keeps the default group order when nothing is saved", () => {
    assert.deepEqual(idsOf(orderedRunTargets(saas, "saas", EMPTY_RUN_ORDER)), ["p:stockPaw", "p:toBloom", "p:xiaochenStudio"]);
  });

  it("lets the saved order win over the default, case-insensitively, with unlisted projects last", () => {
    const order: RunOrder = { targets: { saas: ["xiaochenstudio", "tobloom"] }, services: {} };
    assert.deepEqual(idsOf(orderedRunTargets(saas, "saas", order)), ["p:xiaochenStudio", "p:toBloom", "p:stockPaw"]);
  });

  it("only applies a group's saved order to that group", () => {
    const order: RunOrder = { targets: { someday: ["translationservice"] }, services: {} };
    assert.deepEqual(idsOf(orderedRunTargets(saas, "saas", order)), ["p:stockPaw", "p:toBloom", "p:xiaochenStudio"]);
  });

  it("orders the other group, which has no default table", () => {
    const others = [targetOf("zeta"), targetOf("alpha"), targetOf("mid")];
    assert.deepEqual(idsOf(orderedRunTargets(others, "other", EMPTY_RUN_ORDER)), ["p:zeta", "p:alpha", "p:mid"]);
    const order: RunOrder = { targets: { other: ["mid", "zeta"] }, services: {} };
    assert.deepEqual(idsOf(orderedRunTargets(others, "other", order)), ["p:mid", "p:zeta", "p:alpha"]);
  });

  it("reorders the service rows of a project and keeps each mobile app as one row", () => {
    const rows = groupRunServices([{ name: "api" }, { name: "web" }, { name: "mobile-shop-ios" }, { name: "mobile-shop-android" }]);
    assert.deepEqual(namesOf(orderedRunServiceRows(`${ROOT}/GitNRun`, rows, EMPTY_RUN_ORDER)), ["api", "web", "mobile-shop"]);
    const order: RunOrder = { targets: {}, services: { gitnrun: ["mobile-shop", "web"] } };
    const ordered = orderedRunServiceRows(`${ROOT}/GitNRun`, rows, order);
    assert.deepEqual(namesOf(ordered), ["mobile-shop", "web", "api"]);
    assert.equal(ordered[0]?.kind, "mobile");
  });

  it("applies the saved service order on top of the built-in fictionPurr order", () => {
    const rows = groupRunServices([{ name: "web-fictionpurr" }, { name: "api" }, { name: "desktop-mahopurr" }]);
    assert.deepEqual(namesOf(orderedRunServiceRows(`${ROOT}/fictionPurr`, rows, EMPTY_RUN_ORDER)), ["api", "desktop-mahopurr", "web-fictionpurr"]);
    const order: RunOrder = { targets: {}, services: { fictionpurr: ["web-fictionpurr"] } };
    assert.deepEqual(namesOf(orderedRunServiceRows(`${ROOT}/fictionPurr`, rows, order)), ["web-fictionpurr", "api", "desktop-mahopurr"]);
  });

  it("is not confused by a project folder named like an object property", () => {
    const rows = groupRunServices([{ name: "api" }, { name: "web" }]);
    for (const name of ["constructor", "__proto__", "toString"]) {
      assert.deepEqual(namesOf(orderedRunServiceRows(`${ROOT}/${name}`, rows, EMPTY_RUN_ORDER)), ["api", "web"], name);
      assert.deepEqual(idsOf(orderedRunTargets([targetOf(name)], "other", EMPTY_RUN_ORDER)), [`p:${name}`], name);
    }
  });
});

describe("order entries and committing", () => {
  const targets = [targetOf("toBloom", ["api", "web"]), targetOf("stockPaw", ["api", "mobile-app-ios", "mobile-app-android"]), targetOf("xiaochenStudio")];

  it("builds entries in display order with the service labels", () => {
    const entries = buildRunOrderEntries(targets, "saas", EMPTY_RUN_ORDER);
    assert.deepEqual(entries.map((entry) => entry.key), ["stockpaw", "tobloom", "xiaochenstudio"]);
    assert.deepEqual(entries[0]?.apps.map((app) => app.key), ["api", "mobile-app"]);
    assert.deepEqual(entries[1]?.apps.map((app) => app.label), ["api", "web"]);
    assert.deepEqual(entries[2]?.apps, []);
  });

  it("saves the changed lists and reads them back in the same order", () => {
    const defaults = buildRunOrderEntries(targets, "saas", EMPTY_RUN_ORDER);
    const draft = moveItem(defaults, 0, 1).map((entry) => (entry.key === "tobloom" ? { ...entry, apps: moveItem(entry.apps, 0, 1) } : entry));
    const saved = parseRunOrder(serializeRunOrder(commitRunOrder(EMPTY_RUN_ORDER, "saas", draft, defaults)));
    assert.deepEqual(buildRunOrderEntries(targets, "saas", saved).map((entry) => entry.key), ["tobloom", "stockpaw", "xiaochenstudio"]);
    assert.deepEqual(buildRunOrderEntries(targets, "saas", saved)[0]?.apps.map((app) => app.key), ["web", "api"]);
    assert.deepEqual(saved.services, { tobloom: ["web", "api"] });
  });

  it("drops lists that match the default again and leaves other groups alone", () => {
    const defaults = buildRunOrderEntries(targets, "saas", EMPTY_RUN_ORDER);
    const before: RunOrder = {
      targets: { saas: ["tobloom"], someday: ["fictionpurr"] },
      services: { tobloom: ["web", "api"], gitnrun: ["a", "b"] }
    };
    const after = commitRunOrder(before, "saas", defaults, defaults);
    assert.deepEqual(after, { targets: { someday: ["fictionpurr"] }, services: { gitnrun: ["a", "b"] } });
  });

  it("does not change the order it was given", () => {
    const defaults = buildRunOrderEntries(targets, "saas", EMPTY_RUN_ORDER);
    const before: RunOrder = { targets: { saas: ["tobloom"] }, services: {} };
    const snapshot = serializeRunOrder(before);
    commitRunOrder(before, "saas", moveItem(defaults, 0, 1), defaults);
    assert.equal(serializeRunOrder(before), snapshot);
  });
});

describe("committing only the app order", () => {
  const targets = [targetOf("toBloom", ["api", "web"]), targetOf("stockPaw", ["api", "worker"])];

  it("leaves the saved project order alone when projects are locked", () => {
    const defaults = buildRunOrderEntries(targets, "saas", EMPTY_RUN_ORDER);
    const before: RunOrder = { targets: { saas: ["tobloom", "stockpaw"] }, services: {} };
    // 畫面上是自動排序的順序（toBloom 在前），草稿裡專案順序與已存的手動順序不同也不能寫回去。
    const draft = entriesOfTargets([targetOf("stockPaw", ["api", "worker"]), targetOf("toBloom", ["api", "web"])], before).map((entry) =>
      entry.key === "stockpaw" ? { ...entry, apps: moveItem(entry.apps, 0, 1) } : entry
    );
    const after = commitRunOrder(before, "saas", draft, defaults, { projects: false });
    assert.deepEqual(after.targets, { saas: ["tobloom", "stockpaw"] });
    assert.deepEqual(after.services, { stockpaw: ["worker", "api"] });
  });

  it("still saves the project order when projects are not locked", () => {
    const defaults = buildRunOrderEntries(targets, "saas", EMPTY_RUN_ORDER);
    const after = commitRunOrder(EMPTY_RUN_ORDER, "saas", moveItem(defaults, 0, 1), defaults);
    assert.deepEqual(after.targets, { saas: ["tobloom", "stockpaw"] });
  });
});

describe("sort modes", () => {
  it("defaults every tab to manual", () => {
    assert.equal(runSortModeOf(EMPTY_RUN_SORT_MODES, "saas"), "manual");
    assert.equal(runSortModeOf(withRunSortMode(EMPTY_RUN_SORT_MODES, "saas", "issues"), "someday"), "manual");
  });

  it("remembers the mode per tab and drops the record when going back to manual", () => {
    const issues = withRunSortMode(withRunSortMode(EMPTY_RUN_SORT_MODES, "saas", "issues"), "someday", "issues");
    assert.equal(runSortModeOf(issues, "saas"), "issues");
    assert.equal(runSortModeOf(issues, "someday"), "issues");
    const back = withRunSortMode(issues, "saas", "manual");
    assert.equal(runSortModeOf(back, "saas"), "manual");
    assert.deepEqual(back, { someday: "issues" });
    assert.deepEqual(withRunSortMode(back, "someday", "manual"), {});
  });

  it("round-trips through storage and ignores anything that is not a valid record", () => {
    const modes = withRunSortMode(EMPTY_RUN_SORT_MODES, "saas", "issues");
    assert.deepEqual(parseRunSortModes(serializeRunSortModes(modes)), modes);
    for (const stored of [null, undefined, "", "not json", "[]", "null", "7"]) {
      assert.deepEqual(parseRunSortModes(stored), EMPTY_RUN_SORT_MODES, String(stored));
    }
    assert.deepEqual(parseRunSortModes('{"saas":"issues","someday":"manual","personal":1,"x":null}'), { saas: "issues" });
  });

  it("is not confused by a tab id named like an object property", () => {
    assert.equal(runSortModeOf(EMPTY_RUN_SORT_MODES, "constructor" as never), "manual");
    assert.equal(runSortModeOf(parseRunSortModes('{"__proto__":"issues"}'), "saas"), "manual");
  });
});

describe("sorting by open issues", () => {
  const projectOf = (name: string, patch: Partial<GitLiteProject>): GitLiteProject =>
    ({
      id: `p:${name}`,
      label: name,
      folder: `${ROOT}/${name}`,
      repo: { owner: "me", repo: name, url: `https://github.com/me/${name}` },
      issues: [],
      issuesTruncated: false,
      issueError: null,
      issueErrorKind: null,
      ...patch
    }) as unknown as GitLiteProject;
  const issuesOf = (count: number): GitLiteProject["issues"] =>
    Array.from({ length: count }, (_, index) => ({ id: index, number: index + 1, title: "t", url: "u", author: "a", updatedAt: 0 }));
  const readyFeed = (...projects: GitLiteProject[]): IssueFeed => ({ status: "ready", overview: { githubTokenConfigured: true, projects } });

  const saas = [targetOf("stockPaw"), targetOf("toBloom"), targetOf("xiaochenStudio")];

  it("counts the open issues of a project, and treats anything unreadable as unknown rather than zero", () => {
    const feed = readyFeed(
      projectOf("stockPaw", { issues: issuesOf(3) }),
      projectOf("toBloom", { issues: [] }),
      projectOf("xiaochenStudio", { issueErrorKind: "no-token", issueError: "no token" })
    );
    assert.equal(openIssueCountOf(feed, `${ROOT}/stockPaw`), 3);
    assert.equal(openIssueCountOf(feed, `${ROOT}/toBloom`), 0);
    assert.equal(openIssueCountOf(feed, `${ROOT}/xiaochenStudio`), null);
    assert.equal(openIssueCountOf(feed, `${ROOT}/notInOverview`), null);
    assert.equal(openIssueCountOf(readyFeed(projectOf("toBloom", { repo: null })), `${ROOT}/toBloom`), null);
    assert.equal(openIssueCountOf({ status: "loading" }, `${ROOT}/stockPaw`), null);
    assert.equal(openIssueCountOf({ status: "failed", message: "x" }, `${ROOT}/stockPaw`), null);
  });

  it("does not read issues for the groups that skip them", () => {
    const feed = readyFeed(projectOf("GitNRun", { issues: issuesOf(9) }), projectOf("Usage-Pulse", { issues: issuesOf(4) }));
    assert.equal(openIssueCountOf(feed, `${ROOT}/GitNRun`), null);
    assert.equal(openIssueCountOf(feed, `${ROOT}/Usage-Pulse`), null);
  });

  it("puts the project with the most issues first, and keeps the incoming order for equal counts", () => {
    const feed = readyFeed(
      projectOf("stockPaw", { issues: issuesOf(2) }),
      projectOf("toBloom", { issues: issuesOf(5) }),
      projectOf("xiaochenStudio", { issues: issuesOf(2) })
    );
    assert.deepEqual(idsOf(sortByOpenIssues(saas, feed)), ["p:toBloom", "p:stockPaw", "p:xiaochenStudio"]);
    const reversedTie = [targetOf("xiaochenStudio"), targetOf("stockPaw"), targetOf("toBloom")];
    assert.deepEqual(idsOf(sortByOpenIssues(reversedTie, feed)), ["p:toBloom", "p:xiaochenStudio", "p:stockPaw"]);
  });

  it("sorts projects without a readable count after those with one, even after a project with zero issues", () => {
    const feed = readyFeed(
      projectOf("stockPaw", { issueErrorKind: "network", issueError: "offline" }),
      projectOf("toBloom", { issues: [] }),
      projectOf("xiaochenStudio", { issues: issuesOf(1) })
    );
    assert.deepEqual(idsOf(sortByOpenIssues(saas, feed)), ["p:xiaochenStudio", "p:toBloom", "p:stockPaw"]);
  });

  it("counts a truncated list as the lower bound it is", () => {
    const feed = readyFeed(projectOf("stockPaw", { issues: issuesOf(30), issuesTruncated: true }), projectOf("toBloom", { issues: issuesOf(30) }));
    assert.equal(openIssueCountOf(feed, `${ROOT}/stockPaw`), 30);
    assert.deepEqual(idsOf(sortByOpenIssues(saas, feed)).slice(0, 2), ["p:stockPaw", "p:toBloom"]);
  });

  it("leaves the order untouched while the data is loading or failed, and does not change the input", () => {
    for (const feed of [{ status: "loading" } as const, { status: "failed", message: "x" } as const]) {
      assert.deepEqual(idsOf(sortByOpenIssues(saas, feed)), ["p:stockPaw", "p:toBloom", "p:xiaochenStudio"]);
    }
    const input = [...saas];
    sortByOpenIssues(input, readyFeed(projectOf("toBloom", { issues: issuesOf(5) })));
    assert.deepEqual(idsOf(input), idsOf(saas));
  });

  it("builds the editor entries in the order it is given", () => {
    const entries = entriesOfTargets([targetOf("toBloom", ["api"]), targetOf("stockPaw", ["web"])], EMPTY_RUN_ORDER);
    assert.deepEqual(entries.map((entry) => entry.key), ["tobloom", "stockpaw"]);
  });
});
