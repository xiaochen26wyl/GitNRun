import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TIME_RANGES, errorMessage, formatRelative, rangeToFromMs, shortSha } from "@shared/format";

describe("formatRelative", () => {
  const now = 10_000_000;
  it("uses coarse human units", () => {
    assert.equal(formatRelative(now - 3_000, now), "剛剛");
    assert.equal(formatRelative(now - 30_000, now), "30 秒前");
    assert.equal(formatRelative(now - 5 * 60_000, now), "5 分鐘前");
    assert.equal(formatRelative(now - 3 * 3_600_000, now), "3 小時前");
    assert.equal(formatRelative(now - 3 * 24 * 3_600_000, now), "3 天前");
  });
});

describe("shortSha", () => {
  it("shortens to seven characters and handles null", () => {
    assert.equal(shortSha("abcdef1234567890"), "abcdef1");
    assert.equal(shortSha(null), "—");
  });
});

describe("rangeToFromMs", () => {
  it("converts a preset to a lower bound, and 'all' to none", () => {
    assert.equal(rangeToFromMs("1h", 10_000_000), 10_000_000 - 3_600_000);
    assert.equal(rangeToFromMs("all", 10_000_000), undefined);
    assert.equal(rangeToFromMs("bogus", 10_000_000), undefined);
    assert.ok(TIME_RANGES.some((range) => range.id === "all"));
  });
});

describe("errorMessage", () => {
  it("strips Electron's IPC prefix and error class name", () => {
    assert.equal(
      errorMessage(new Error("Error invoking remote method 'projects:add': UserFacingError: 已經在監視這個 repo 了")),
      "已經在監視這個 repo 了"
    );
    assert.equal(errorMessage(new Error("Error invoking remote method 'x:y': Error: 金鑰格式不正確。")), "金鑰格式不正確。");
  });

  it("passes ordinary messages through and has a fallback", () => {
    assert.equal(errorMessage(new Error("plain")), "plain");
    assert.equal(errorMessage("text"), "text");
    assert.equal(errorMessage(undefined), "操作失敗");
    assert.equal(errorMessage(new Error("")), "操作失敗");
  });
});
