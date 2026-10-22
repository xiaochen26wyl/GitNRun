import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_ACCOUNT_LENGTH, normalizeRunAccount } from "@shared/run";
import { accountCopyState, accountDraftOf } from "@shared/run-account";

describe("accountCopyState", () => {
  it("沒設定帳號不能複製並說明原因，有帳號才能複製", () => {
    assert.deepEqual(accountCopyState(""), { canCopy: false, reason: "先設定帳號" });
    assert.deepEqual(accountCopyState("   "), { canCopy: false, reason: "先設定帳號" });
    assert.deepEqual(accountCopyState("dev@example.com"), { canCopy: true, reason: "" });
  });
});

describe("accountDraftOf", () => {
  it("修剪前後空白，空字串合法（代表清除）", () => {
    assert.deepEqual(accountDraftOf("  dev@example.com \n"), { ok: true, account: "dev@example.com" });
    assert.deepEqual(accountDraftOf("   "), { ok: true, account: "" });
  });
  it("超過長度或含控制字元會被拒絕，並給出不同原因", () => {
    const tooLong = accountDraftOf("a".repeat(MAX_ACCOUNT_LENGTH + 1));
    assert.equal(tooLong.ok, false);
    assert.match(tooLong.ok ? "" : tooLong.reason, /不能超過/);
    const control = accountDraftOf("dev\u0000@example.com");
    assert.equal(control.ok, false);
    assert.match(control.ok ? "" : control.reason, /控制字元/);
  });
  it("結果與主程序的 normalizeRunAccount 一致", () => {
    for (const input of ["a@b.c", "  x  ", "", "a".repeat(MAX_ACCOUNT_LENGTH), "a".repeat(MAX_ACCOUNT_LENGTH + 1), "bad\u0007"]) {
      const draft = accountDraftOf(input);
      const normalized = normalizeRunAccount(input);
      assert.equal(draft.ok, normalized !== null);
      if (draft.ok) assert.equal(draft.account, normalized);
    }
  });
});
