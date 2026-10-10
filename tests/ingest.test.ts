import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PushEvent } from "@shared/events";
import { queryEvents } from "@main/db/events-repo";
import { addProject } from "@main/db/projects-repo";
import { createIngest } from "@main/monitor/ingest";
import { createTestDb, makeEvent } from "./helpers/db";

const setup = () => {
  const db = createTestDb();
  const project = addProject(db, {
    owner: "acme", repo: "widgets", name: "acme/widgets", localPath: null,
    branchFilter: ["*"], pollIntervalSec: 30, mode: "poll", enabled: true, aiEnabled: false
  });
  return { db, project };
};

describe("createIngest", () => {
  it("stores the event and notifies every downstream handler once", async () => {
    const { db, project } = setup();
    const seen: string[] = [];
    const ingest = createIngest({
      db,
      onNewEvent: [() => void seen.push("notify"), async () => void seen.push("rules")]
    });

    const result = await ingest(project, makeEvent(project.id));

    assert.equal(result.inserted, true);
    assert.deepEqual(seen, ["notify", "rules"]);
    assert.equal(queryEvents(db).events.length, 1);
  });

  it("ignores a duplicate: no second row, no second notification, no second rule run", async () => {
    const { db, project } = setup();
    let calls = 0;
    const ingest = createIngest({ db, onNewEvent: [() => void (calls += 1)] });
    const event = makeEvent(project.id);

    await ingest(project, { ...event, source: "poll" });
    const duplicate = await ingest(project, { ...event, source: "webhook", pusherInferred: false });

    assert.equal(duplicate.inserted, false);
    assert.equal(calls, 1);
    assert.equal(queryEvents(db).events.length, 1);
  });

  it("flags branch-name violations, but never for deletions", async () => {
    const { db, project } = setup();
    const ingest = createIngest({ db, isBranchViolation: (_project, branch) => branch.startsWith("bad") });

    await ingest(project, makeEvent(project.id, { branch: "bad-name", ref: "refs/heads/bad-name" }));
    await ingest(project, makeEvent(project.id, { branch: "good", ref: "refs/heads/good" }));
    await ingest(project, makeEvent(project.id, { branch: "bad-gone", ref: "refs/heads/bad-gone", eventType: "delete" }));

    const byBranch = new Map(queryEvents(db).events.map((event) => [event.branch, event.branchViolation]));
    assert.equal(byBranch.get("bad-name"), true);
    assert.equal(byBranch.get("good"), false);
    assert.equal(byBranch.get("bad-gone"), false);
  });

  it("keeps the stored event even when a downstream handler throws, and still runs the rest", async () => {
    const { db, project } = setup();
    const errors: unknown[] = [];
    const reached: PushEvent[] = [];
    const ingest = createIngest({
      db,
      onNewEvent: [
        () => {
          throw new Error("notification failed");
        },
        (event) => void reached.push(event)
      ],
      onError: (error) => errors.push(error)
    });

    const result = await ingest(project, makeEvent(project.id));

    assert.equal(result.inserted, true);
    assert.equal(errors.length, 1);
    assert.equal(reached.length, 1);
    assert.equal(queryEvents(db).events.length, 1);
  });
});
