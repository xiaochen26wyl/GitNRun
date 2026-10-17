import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateProjectInput, isRepoPart } from "@shared/projects";
import {
  DuplicateProjectError,
  addProject,
  getProject,
  listProjects,
  removeProject,
  updateProject
} from "@main/db/projects-repo";
import { getHeads, getPollMeta, savePollMeta, setHead } from "@main/db/poll-state-repo";
import { insertEvent } from "@main/db/events-repo";
import { createTestDb, makeEvent } from "./helpers/db";

const valid = { owner: "acme", repo: "widgets" };

describe("validateProjectInput", () => {
  it("fills defaults", () => {
    const result = validateProjectInput(valid);
    assert.ok(result.ok);
    assert.deepEqual(result.value, {
      owner: "acme",
      repo: "widgets",
      name: "acme/widgets",
      localPath: null,
      branchFilter: ["*"],
      pollIntervalSec: 30,
      mode: "poll",
      enabled: true,
    aiEnabled: false
    });
  });

  it("trims names and keeps provided options", () => {
    const result = validateProjectInput({
      owner: " acme ", repo: " widgets ", name: " My Widgets ", localPath: "/Users/me/widgets",
      branchFilter: [" main ", "release/*"], pollIntervalSec: 60, mode: "both", enabled: false
    });
    assert.ok(result.ok);
    assert.equal(result.value.name, "My Widgets");
    assert.deepEqual(result.value.branchFilter, ["main", "release/*"]);
    assert.equal(result.value.mode, "both");
    assert.equal(result.value.enabled, false);
  });

  it("rejects bad names, path traversal and non-objects", () => {
    for (const bad of [
      null, "x", [], {},
      { owner: "..", repo: "x" },
      { owner: "a/b", repo: "x" },
      { owner: "acme", repo: "../etc" },
      { owner: "acme", repo: "" },
      { owner: "acme", repo: "x".repeat(101) }
    ]) {
      assert.equal(validateProjectInput(bad).ok, false, JSON.stringify(bad));
    }
  });

  it("enforces the poll interval range, mode, local path and filter sanity", () => {
    assert.equal(validateProjectInput({ ...valid, pollIntervalSec: 14 }).ok, false);
    assert.equal(validateProjectInput({ ...valid, pollIntervalSec: 3601 }).ok, false);
    assert.equal(validateProjectInput({ ...valid, pollIntervalSec: 20.5 }).ok, false);
    assert.equal(validateProjectInput({ ...valid, pollIntervalSec: 15 }).ok, true);
    assert.equal(validateProjectInput({ ...valid, mode: "push" }).ok, false);
    assert.equal(validateProjectInput({ ...valid, localPath: "relative/path" }).ok, false);
    assert.equal(validateProjectInput({ ...valid, localPath: "/a\nb" }).ok, false);
    assert.equal(validateProjectInput({ ...valid, branchFilter: [] }).ok, false);
    assert.equal(validateProjectInput({ ...valid, branchFilter: [""] }).ok, false);
    assert.equal(validateProjectInput({ ...valid, branchFilter: "main" }).ok, false);
    assert.equal(validateProjectInput({ ...valid, enabled: "yes" }).ok, false);
  });
});

describe("isRepoPart", () => {
  it("allows GitHub-style names only", () => {
    for (const ok of ["acme", "my-repo", "my_repo", "repo.js", "A1"]) {
      assert.equal(isRepoPart(ok), true, ok);
    }
    for (const bad of [".", "..", "a b", "a/b", "", "é", 5, null]) {
      assert.equal(isRepoPart(bad), false, String(bad));
    }
  });
});

const normalized = (overrides: Record<string, unknown> = {}) => {
  const result = validateProjectInput({ ...valid, ...overrides });
  assert.ok(result.ok);
  return result.value;
};

describe("projects repo", () => {
  it("adds, lists, reads and removes", () => {
    const db = createTestDb();
    const project = addProject(db, normalized(), 123);
    assert.equal(project.owner, "acme");
    assert.equal(project.createdAt, 123);
    assert.equal(project.aiEnabled, false);
    assert.equal(listProjects(db).length, 1);
    assert.equal(getProject(db, project.id)?.repo, "widgets");
    assert.equal(removeProject(db, project.id), true);
    assert.equal(removeProject(db, project.id), false);
    assert.equal(getProject(db, project.id), null);
  });

  it("rejects the same repository twice", () => {
    const db = createTestDb();
    addProject(db, normalized());
    assert.throws(() => addProject(db, normalized()), DuplicateProjectError);
  });

  it("removing a project removes its events and poll state", () => {
    const db = createTestDb();
    const project = addProject(db, normalized());
    insertEvent(db, makeEvent(project.id));
    setHead(db, project.id, "main", "a".repeat(40), 1);
    savePollMeta(db, project.id, { baselineDone: true });

    removeProject(db, project.id);

    for (const table of ["push_events", "poll_state", "poll_meta"]) {
      assert.equal(Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n), 0, table);
    }
  });

  it("changing the branch filter resets the polling baseline; other edits keep it", () => {
    const db = createTestDb();
    const project = addProject(db, normalized());
    setHead(db, project.id, "main", "a".repeat(40), 1);
    savePollMeta(db, project.id, { baselineDone: true, etag: 'W/"x"' });

    updateProject(db, project.id, normalized({ pollIntervalSec: 60, name: "renamed" }));
    assert.equal(getPollMeta(db, project.id).baselineDone, true);
    assert.equal(getHeads(db, project.id).size, 1);
    assert.equal(getProject(db, project.id)?.name, "renamed");

    updateProject(db, project.id, normalized({ branchFilter: ["main"] }));
    assert.equal(getPollMeta(db, project.id).baselineDone, false);
    assert.equal(getHeads(db, project.id).size, 0);
  });

  it("returns null when updating a project that does not exist", () => {
    assert.equal(updateProject(createTestDb(), 999, normalized()), null);
  });

  it("checks whether localPath exists on disk when adding, and only rechecks on update if localPath changed", () => {
    const db = createTestDb();
    const missing = addProject(db, normalized({ localPath: "/definitely/not/a/real/path/xyz" }));
    assert.equal(missing.pathExists, false);

    const present = addProject(db, normalized({ owner: "acme2", localPath: process.cwd() }));
    assert.equal(present.pathExists, true);

    // localPath 不變，即使磁碟上的路徑之後消失，updateProject 也不會重新檢查。
    const renamed = updateProject(db, present.id, normalized({ owner: "acme2", localPath: process.cwd(), name: "renamed" }));
    assert.equal(renamed?.pathExists, true);

    // localPath 真的改了才重新檢查。
    const moved = updateProject(
      db,
      present.id,
      normalized({ owner: "acme2", localPath: "/definitely/not/a/real/path/xyz" })
    );
    assert.equal(moved?.pathExists, false);
  });
});
