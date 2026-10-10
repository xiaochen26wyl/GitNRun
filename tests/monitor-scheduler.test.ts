import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PollScheduler, failureDelayMs } from "@main/monitor/scheduler";

const T0 = 1_000_000;

describe("PollScheduler basics", () => {
  it("staggers newly registered projects within the first few seconds", () => {
    const scheduler = new PollScheduler({ random: () => 0.5 });
    scheduler.upsert(1, 30, T0);
    scheduler.upsert(2, 3, T0);

    const [first, second] = scheduler.snapshot();
    assert.equal(first?.nextDueAt, T0 + 2_500); // 0.5 * min(30s, 5s)
    assert.equal(second?.nextDueAt, T0 + 1_500); // 0.5 * min(3s, 5s)
  });

  it("takes only due projects, oldest first, and marks them in flight", () => {
    const scheduler = new PollScheduler({ random: () => 0, concurrency: 10 });
    scheduler.upsert(1, 30, T0);
    scheduler.upsert(2, 30, T0 + 10_000);

    assert.deepEqual(scheduler.takeDue(T0), [1]);
    assert.deepEqual(scheduler.takeDue(T0), [], "already in flight");
    assert.deepEqual(scheduler.takeDue(T0 + 10_000), [2]);
  });

  it("never exceeds the concurrency cap", () => {
    const scheduler = new PollScheduler({ random: () => 0, concurrency: 2 });
    for (const id of [1, 2, 3, 4]) {
      scheduler.upsert(id, 30, T0);
    }
    assert.equal(scheduler.takeDue(T0).length, 2);
    assert.equal(scheduler.takeDue(T0).length, 0);
    scheduler.complete(1, T0);
    assert.equal(scheduler.takeDue(T0 + 60_000).length, 1);
  });

  it("schedules the next run one interval later with ±10% jitter", () => {
    for (const [random, expected] of [[0, 27_000], [0.5, 30_000], [1, 33_000]] as const) {
      const scheduler = new PollScheduler({ random: () => random });
      scheduler.upsert(1, 30, T0);
      scheduler.takeDue(T0 + 10_000);
      scheduler.complete(1, T0);
      const actual = scheduler.snapshot()[0]?.nextDueAt ?? 0;
      assert.ok(Math.abs(actual - (T0 + expected)) < 1, `expected ~${T0 + expected}, got ${actual}`);
    }
  });

  it("updating an existing project changes its interval without resetting its schedule", () => {
    const scheduler = new PollScheduler({ random: () => 0.5 });
    scheduler.upsert(1, 30, T0);
    const before = scheduler.snapshot()[0]?.nextDueAt;
    scheduler.upsert(1, 60, T0 + 100_000);
    assert.equal(scheduler.snapshot()[0]?.nextDueAt, before);
  });

  it("forceDue makes a project due now but not one that is already running", () => {
    const scheduler = new PollScheduler({ random: () => 0 });
    scheduler.upsert(1, 600, T0);
    scheduler.takeDue(T0);
    scheduler.complete(1, T0);
    assert.deepEqual(scheduler.takeDue(T0 + 1000), []);
    scheduler.forceDue(1, T0 + 1000);
    assert.deepEqual(scheduler.takeDue(T0 + 1000), [1]);
    scheduler.forceDue(1, T0 + 2000);
    assert.deepEqual(scheduler.takeDue(T0 + 2000), []);
  });

  it("acquire refuses a project that is already running", () => {
    const scheduler = new PollScheduler({ random: () => 0 });
    scheduler.upsert(1, 30, T0);
    assert.equal(scheduler.acquire(1), true);
    assert.equal(scheduler.acquire(1), false);
    assert.equal(scheduler.acquire(99), false);
  });

  it("removes projects", () => {
    const scheduler = new PollScheduler({ random: () => 0 });
    scheduler.upsert(1, 30, T0);
    scheduler.remove(1);
    assert.deepEqual(scheduler.takeDue(T0 + 100_000), []);
  });
});

describe("failures", () => {
  it("backs off exponentially for network errors, capped at 10 minutes", () => {
    assert.equal(failureDelayMs("network", 1, 30), 30_000);
    assert.equal(failureDelayMs("network", 2, 30), 60_000);
    assert.equal(failureDelayMs("network", 3, 30), 120_000);
    assert.equal(failureDelayMs("network", 20, 30), 600_000);
    assert.equal(failureDelayMs("server", 1, 5), 15_000, "never below the 15s floor");
  });

  it("retries permission-type failures slowly and a missing token quickly", () => {
    for (const kind of ["auth", "forbidden", "not-found"] as const) {
      assert.equal(failureDelayMs(kind, 1, 30), 300_000);
      assert.equal(failureDelayMs(kind, 9, 30), 300_000);
    }
    assert.equal(failureDelayMs("no-token", 4, 30), 30_000);
  });

  it("applies the delay, frees the slot and resets after a success", () => {
    const scheduler = new PollScheduler({ random: () => 0.5, concurrency: 1 });
    scheduler.upsert(1, 30, T0);
    scheduler.takeDue(T0 + 10_000);
    scheduler.fail(1, T0, "network");
    scheduler.takeDue(T0);
    scheduler.fail(1, T0, "network");

    const entry = scheduler.snapshot()[0];
    assert.equal(entry?.failures, 2);
    assert.equal(entry?.nextDueAt, T0 + 60_000);
    assert.equal(entry?.inFlight, false);

    scheduler.takeDue(T0 + 60_000);
    scheduler.complete(1, T0 + 60_000);
    assert.equal(scheduler.snapshot()[0]?.failures, 0);
  });
});

describe("pause and rate limits", () => {
  it("hands out nothing while paused", () => {
    const scheduler = new PollScheduler({ random: () => 0 });
    scheduler.upsert(1, 30, T0);
    scheduler.pauseUntil(T0 + 5000);
    assert.deepEqual(scheduler.takeDue(T0 + 1000), []);
    assert.equal(scheduler.isPaused(T0 + 1000), true);
    assert.deepEqual(scheduler.takeDue(T0 + 5000), [1]);
    assert.equal(scheduler.isPaused(T0 + 5000), false);
  });

  it("slows everything down as the quota shrinks", () => {
    const scheduler = new PollScheduler({ random: () => 0.5 });
    scheduler.applyRateLimit({ remaining: 4000, resetAt: null }, T0);
    assert.equal(scheduler.getStretch(), 1);
    scheduler.applyRateLimit({ remaining: 300, resetAt: null }, T0);
    assert.equal(scheduler.getStretch(), 2);
    scheduler.applyRateLimit({ remaining: 50, resetAt: null }, T0);
    assert.equal(scheduler.getStretch(), 4);
    assert.equal(scheduler.isPaused(T0), false);

    scheduler.upsert(1, 30, T0);
    scheduler.takeDue(T0 + 10_000);
    scheduler.complete(1, T0);
    assert.equal(scheduler.snapshot()[0]?.nextDueAt, T0 + 120_000);
  });

  it("pauses until the reset time when the quota is nearly gone, capped at one hour", () => {
    const scheduler = new PollScheduler();
    scheduler.applyRateLimit({ remaining: 3, resetAt: T0 + 120_000 }, T0);
    assert.equal(scheduler.getPausedUntil(), T0 + 120_000);

    const far = new PollScheduler();
    far.applyRateLimit({ remaining: 0, resetAt: T0 + 10 * 3_600_000 }, T0);
    assert.equal(far.getPausedUntil(), T0 + 3_600_000);
  });

  it("ignores responses without rate limit headers", () => {
    const scheduler = new PollScheduler();
    scheduler.applyRateLimit({ remaining: null, resetAt: null }, T0);
    assert.equal(scheduler.getStretch(), 1);
    assert.equal(scheduler.isPaused(T0), false);
  });
});
