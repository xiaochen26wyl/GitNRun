import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addProject } from "@main/db/projects-repo";
import { setSetting } from "@main/db/settings-repo";
import { NOTIFICATIONS_ENABLED_KEY, NOTIFICATIONS_MUTED_PROJECTS_KEY, isNotificationAllowed, readMutedProjectIds } from "@main/notification-prefs";
import { buildTrayItems, statusLabel, type TrayItem, type TrayModel } from "@main/tray-menu";
import { createTestDb } from "./helpers/db";

const model = (overrides: Partial<TrayModel> = {}): TrayModel => ({
  paused: false, rateLimitedUntil: null, projectCount: 2, recentEvents: [], targets: [], ...overrides
});
const labels = (items: TrayItem[]): string[] => items.flatMap((item) => (item.kind === "separator" ? [] : [item.label]));

describe("tray status line", () => {
  it("reflects pause, rate limiting, and an empty setup", () => {
    assert.equal(statusLabel(model()), "監視中（2 個專案）");
    assert.equal(statusLabel(model({ projectCount: 0 })), "尚未設定專案");
    assert.equal(statusLabel(model({ paused: true })), "監視已暫停");
    assert.match(statusLabel(model({ rateLimitedUntil: new Date(2026, 9, 9, 14, 5).getTime() })), /GitHub 限流中，14:05 後恢復/);
    assert.equal(statusLabel(model({ paused: true, rateLimitedUntil: 1 })), "監視已暫停", "the user's own pause wins over the rate-limit note");
  });
});

describe("tray menu", () => {
  it("always offers: status, pause toggle, open window, and quit", () => {
    const items = buildTrayItems(model());
    const actions = items.flatMap((item) => (item.kind === "item" ? [item.action.type] : []));
    assert.deepEqual(actions, ["toggle-pause", "open-window", "quit"]);
    assert.equal(items[0]?.kind, "label");
    assert.equal(items.at(-1)?.kind, "item");
  });

  it("the pause entry flips with the state", () => {
    assert.ok(labels(buildTrayItems(model())).includes("暫停監視"));
    assert.ok(labels(buildTrayItems(model({ paused: true }))).includes("恢復監視"));
  });

  it("lists recent pushes and launch targets when there are some, and says so when there are none", () => {
    const empty = labels(buildTrayItems(model()));
    assert.ok(!empty.includes("最近的推送"));
    assert.ok(empty.includes("尚未設定專案路徑或資料夾映射"));

    const full = buildTrayItems(model({
      recentEvents: [{ label: "acme/api · main" }, { label: "acme/web · dev" }],
      targets: [{ label: "acme/api", folder: "/Users/me/api" }]
    }));
    assert.ok(labels(full).includes("最近的推送"));
    assert.ok(labels(full).includes("acme/web · dev"));
    const launch = full.find((item) => item.kind === "item" && item.action.type === "launch");
    assert.deepEqual(launch && launch.kind === "item" ? launch.action : null, { type: "launch", folder: "/Users/me/api" });
  });

  it("never has two separators in a row or one at either end", () => {
    for (const m of [model(), model({ recentEvents: [{ label: "x" }] }), model({ targets: [{ label: "a", folder: "/a" }] })]) {
      const items = buildTrayItems(m);
      assert.notEqual(items[0]?.kind, "separator");
      assert.notEqual(items.at(-1)?.kind, "separator");
      items.forEach((item, index) => {
        if (item.kind === "separator") assert.notEqual(items[index + 1]?.kind, "separator");
      });
    }
  });
});

describe("notification preferences", () => {
  const project = (db: ReturnType<typeof createTestDb>, repo: string) =>
    addProject(db, { owner: "a", repo, name: repo, localPath: null, branchFilter: ["*"], pollIntervalSec: 30, mode: "poll", enabled: true, aiEnabled: false });

  it("are on for everyone by default", () => {
    const db = createTestDb();
    assert.equal(isNotificationAllowed(db, project(db, "x").id), true);
  });

  it("the global switch silences everything", () => {
    const db = createTestDb();
    const id = project(db, "x").id;
    setSetting(db, NOTIFICATIONS_ENABLED_KEY, false);
    assert.equal(isNotificationAllowed(db, id), false);
  });

  it("a muted project is silent while the others still notify", () => {
    const db = createTestDb();
    const noisy = project(db, "noisy").id;
    const quiet = project(db, "quiet").id;
    setSetting(db, NOTIFICATIONS_MUTED_PROJECTS_KEY, [quiet]);
    assert.equal(isNotificationAllowed(db, noisy), true);
    assert.equal(isNotificationAllowed(db, quiet), false);
  });

  it("junk in the stored list is ignored rather than breaking notifications", () => {
    const db = createTestDb();
    const id = project(db, "x").id;
    setSetting(db, NOTIFICATIONS_MUTED_PROJECTS_KEY, [id, "x", -1, 1.5, null]);
    assert.deepEqual(readMutedProjectIds(db), [id]);
    setSetting(db, NOTIFICATIONS_MUTED_PROJECTS_KEY, "everything");
    assert.deepEqual(readMutedProjectIds(db), []);
  });
});
