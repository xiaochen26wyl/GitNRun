import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addProject } from "@main/db/projects-repo";
import { setSetting } from "@main/db/settings-repo";
import { NOTIFICATIONS_ENABLED_KEY, NOTIFICATIONS_MUTED_PROJECTS_KEY, isNotificationAllowed, readMutedProjectIds } from "@main/notification-prefs";
import { createTestDb } from "./helpers/db";

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
