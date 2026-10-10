import { migrate } from "@main/db/migrations";
import { openDatabase, MEMORY_DB, type Db } from "@main/db/database";
import type { NewPushEvent } from "@shared/events";

export const createTestDb = (): Db => {
  const db = openDatabase(MEMORY_DB);
  migrate(db);
  return db;
};

export const seedProject = (db: Db, owner = "acme", repo = "widgets", now = 1_700_000_000_000): number => {
  const result = db
    .prepare("INSERT INTO projects (name, owner, repo, created_at) VALUES (?, ?, ?, ?)")
    .run(`${owner}/${repo}`, owner, repo, now);
  return Number(result.lastInsertRowid);
};

let counter = 0;

export const makeEvent = (projectId: number, overrides: Partial<NewPushEvent> = {}): NewPushEvent => {
  counter += 1;
  const sha = counter.toString(16).padStart(40, "0");
  return {
    projectId,
    eventType: "push",
    ref: "refs/heads/main",
    branch: "main",
    beforeSha: null,
    afterSha: sha,
    pusher: "octocat",
    pusherInferred: true,
    headMessage: `feat: change ${counter}`,
    commits: [],
    files: [],
    fileCount: 0,
    branchViolation: false,
    source: "poll",
    occurredAt: 1_700_000_000_000 + counter,
    ...overrides
  };
};

import { getEvent, insertEvent } from "@main/db/events-repo";
import type { PushEvent } from "@shared/events";

/** 寫入並讀回完整事件（含 id），規則引擎的測試用。 */
export const storeEvent = (db: Db, projectId: number, overrides: Partial<NewPushEvent> = {}): PushEvent => {
  const { id } = insertEvent(db, makeEvent(projectId, overrides));
  return getEvent(db, id) as PushEvent;
};
