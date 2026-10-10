import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createCrashGuard, createFaultTracker, fileBackedRestartLog, inMemoryRestartLog } from "@main/reliability/crash-guard";

const MINUTE = 60_000;

describe("crash guard", () => {
  const make = (maxRestarts = 3) => {
    let clock = 1_000_000;
    const log = inMemoryRestartLog();
    const guard = createCrashGuard({ maxRestarts, windowMs: 5 * MINUTE, now: () => clock, ...log });
    return { guard, log, advance: (ms: number) => (clock += ms), now: () => clock };
  };

  it("allows a few restarts, then stops the loop", () => {
    const t = make();
    assert.equal(t.guard.allowRestart(), true);
    t.advance(10_000);
    assert.equal(t.guard.allowRestart(), true);
    t.advance(10_000);
    assert.equal(t.guard.allowRestart(), true);
    t.advance(10_000);
    assert.equal(t.guard.allowRestart(), false, "the fourth restart within five minutes is refused");
    assert.equal(t.guard.allowRestart(), false);
  });

  it("recovers once the window has passed", () => {
    const t = make();
    for (let i = 0; i < 3; i += 1) t.guard.allowRestart();
    assert.equal(t.guard.allowRestart(), false);
    t.advance(5 * MINUTE + 1);
    assert.equal(t.guard.allowRestart(), true);
  });

  it("the window slides: old restarts stop counting one by one", () => {
    const t = make(2);
    t.guard.allowRestart(); // t0
    t.advance(3 * MINUTE);
    t.guard.allowRestart(); // t0 + 3m
    t.advance(MINUTE);
    assert.equal(t.guard.allowRestart(), false);
    t.advance(MINUTE + 1); // 第一次已超過 5 分鐘
    assert.equal(t.guard.allowRestart(), true);
  });

  it("a refused restart is not recorded, and reset clears everything", () => {
    const t = make(1);
    t.guard.allowRestart();
    t.guard.allowRestart();
    assert.equal(t.log.load().length, 1);
    t.guard.reset();
    assert.deepEqual(t.log.load(), []);
    assert.equal(t.guard.allowRestart(), true);
  });

  it("ignores timestamps from the future (clock was changed) instead of being locked out forever", () => {
    const t = make();
    t.log.save([t.now() + 10 * MINUTE, t.now() + 11 * MINUTE, t.now() + 12 * MINUTE]);
    assert.equal(t.guard.allowRestart(), true);
  });
});

describe("restart log on disk", () => {
  const root = mkdtempSync(join(tmpdir(), "gitnrun-guard-"));
  after(() => rmSync(root, { recursive: true, force: true }));

  it("survives across processes: what one 'run' saves the next 'run' reads", () => {
    const path = join(root, "restarts.json");
    let clock = 1_000_000;
    const first = createCrashGuard({ maxRestarts: 2, windowMs: 5 * MINUTE, now: () => clock, ...fileBackedRestartLog(path) });
    first.allowRestart();
    clock += 1000;
    first.allowRestart();

    // 重啟後是全新的行程，只能靠檔案記得之前的紀錄。
    const second = createCrashGuard({ maxRestarts: 2, windowMs: 5 * MINUTE, now: () => clock, ...fileBackedRestartLog(path) });
    assert.equal(second.allowRestart(), false);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  it("treats a missing or corrupt file as 'no history' and never throws on a bad path", () => {
    assert.deepEqual(fileBackedRestartLog(join(root, "nope.json")).load(), []);
    const corrupt = join(root, "corrupt.json");
    writeFileSync(corrupt, "{ not json");
    assert.deepEqual(fileBackedRestartLog(corrupt).load(), []);
    writeFileSync(corrupt, JSON.stringify([1, "x", null, 2]));
    assert.deepEqual(fileBackedRestartLog(corrupt).load(), [1, 2]);
    assert.doesNotThrow(() => fileBackedRestartLog(join(root, "no", "such", "dir", "x.json")).save([1]));
    assert.equal(existsSync(join(root, "no")), false);
    assert.equal(readFileSync(corrupt, "utf8").length > 0, true);
  });
});

describe("fault tracker", () => {
  it("occasional errors are only recorded, never fatal", () => {
    let clock = 0;
    const tracker = createFaultTracker({ threshold: 5, windowMs: MINUTE, now: () => clock });

    // 每 20 秒一次：任何 60 秒的窗口裡最多只有 3 次，永遠不會到門檻。
    for (let i = 0; i < 30; i += 1) {
      assert.equal(tracker.record(), false, `error #${i + 1}`);
      clock += 20_000;
    }
  });

  it("five errors inside one window trip it", () => {
    let clock = 0;
    const tracker = createFaultTracker({ threshold: 5, windowMs: MINUTE, now: () => clock });
    const results = Array.from({ length: 5 }, () => {
      clock += 1000;
      return tracker.record();
    });
    assert.deepEqual(results, [false, false, false, false, true]);
  });

  it("errors spaced further apart than the window never add up", () => {
    let clock = 0;
    const tracker = createFaultTracker({ threshold: 3, windowMs: MINUTE, now: () => clock });
    for (let i = 0; i < 20; i += 1) {
      clock += 2 * MINUTE;
      assert.equal(tracker.record(), false);
    }
  });
});
