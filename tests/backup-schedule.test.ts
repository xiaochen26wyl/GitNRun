import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isBackupOverdue, lastBackupSlot, nextBackupAt } from "@main/backup-schedule";

// 一律用本地時間建立，與實作的本地時區判斷一致。
const at = (y: number, m: number, d: number, h = 0, min = 0): number => new Date(y, m - 1, d, h, min, 0, 0).getTime();

describe("nextBackupAt", () => {
  it("is today at 22:00 before the slot", () => {
    assert.equal(nextBackupAt(at(2026, 10, 14, 21, 59)), at(2026, 10, 14, 22));
    assert.equal(nextBackupAt(at(2026, 10, 14, 0, 0)), at(2026, 10, 14, 22));
  });

  it("is tomorrow at 22:00 at or after the slot", () => {
    assert.equal(nextBackupAt(at(2026, 10, 14, 22)), at(2026, 10, 15, 22));
    assert.equal(nextBackupAt(at(2026, 10, 14, 23, 30)), at(2026, 10, 15, 22));
  });

  it("rolls over month and year ends", () => {
    assert.equal(nextBackupAt(at(2026, 10, 31, 23)), at(2026, 11, 1, 22));
    assert.equal(nextBackupAt(at(2026, 12, 31, 22, 30)), at(2027, 1, 1, 22));
  });
});

describe("isBackupOverdue", () => {
  const now = at(2026, 10, 14, 9);

  it("is false when the latest backup is after the last 22:00", () => {
    assert.equal(lastBackupSlot(now), at(2026, 10, 13, 22));
    assert.equal(isBackupOverdue(now, at(2026, 10, 13, 22, 1)), false);
    assert.equal(isBackupOverdue(now, at(2026, 10, 14, 8)), false);
  });

  it("is true when the last 22:00 was missed", () => {
    assert.equal(isBackupOverdue(now, at(2026, 10, 13, 21, 59)), true);
    assert.equal(isBackupOverdue(at(2026, 10, 14, 22, 5), at(2026, 10, 13, 22, 1)), true);
  });

  it("is true when there is no backup at all", () => {
    assert.equal(isBackupOverdue(now, null), true);
  });
});
