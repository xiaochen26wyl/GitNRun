import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IPC } from "@shared/ipc";
import {
  InvalidIpcInputError,
  MAX_IPC_STRING,
  asBoundedString,
  asEnum,
  asNoArgs,
  asRunAccountArgs,
  asRunActionArgs,
  asRunTargetIdArgs,
  asSafeInteger,
  isKnownChannel,
  runValidated
} from "@main/ipc-validation";

describe("isKnownChannel", () => {
  it("accepts every declared channel", () => {
    for (const channel of Object.values(IPC)) {
      assert.equal(isKnownChannel(channel), true);
    }
  });

  it("rejects unknown channels and non-strings", () => {
    assert.equal(isKnownChannel("app:evil"), false);
    assert.equal(isKnownChannel("__proto__"), false);
    assert.equal(isKnownChannel(undefined), false);
    assert.equal(isKnownChannel(42), false);
  });
});

describe("asBoundedString", () => {
  it("accepts ordinary strings", () => {
    assert.equal(asBoundedString("main"), "main");
  });

  it("rejects non-strings", () => {
    for (const value of [null, undefined, 1, {}, [], true]) {
      assert.equal(asBoundedString(value), null);
    }
  });

  it("rejects over-long strings", () => {
    assert.equal(asBoundedString("a".repeat(MAX_IPC_STRING + 1)), null);
    assert.equal(asBoundedString("a".repeat(MAX_IPC_STRING)), "a".repeat(MAX_IPC_STRING));
    assert.equal(asBoundedString("abcd", { max: 3 }), null);
  });

  it("rejects empty strings unless allowed", () => {
    assert.equal(asBoundedString(""), null);
    assert.equal(asBoundedString("", { allowEmpty: true }), "");
  });

  it("rejects control characters unless allowed", () => {
    assert.equal(asBoundedString("a\nb"), null);
    assert.equal(asBoundedString("a\u0000b"), null);
    assert.equal(asBoundedString("a\nb", { allowControl: true }), "a\nb");
  });
});

describe("asSafeInteger", () => {
  it("enforces type and range", () => {
    assert.equal(asSafeInteger(15, 15, 3600), 15);
    assert.equal(asSafeInteger(14, 15, 3600), null);
    assert.equal(asSafeInteger(3601, 15, 3600), null);
    assert.equal(asSafeInteger(20.5, 15, 3600), null);
    assert.equal(asSafeInteger("20", 15, 3600), null);
    assert.equal(asSafeInteger(Number.NaN, 15, 3600), null);
  });
});

describe("asEnum", () => {
  it("only accepts listed values", () => {
    assert.equal(asEnum("table", ["table", "card"] as const), "table");
    assert.equal(asEnum("grid", ["table", "card"] as const), null);
    assert.equal(asEnum(1, ["table", "card"] as const), null);
  });
});

describe("runValidated", () => {
  it("does not call the handler when validation fails", async () => {
    let called = false;
    await assert.rejects(
      runValidated(asNoArgs, ["unexpected"], () => {
        called = true;
      }),
      InvalidIpcInputError
    );
    assert.equal(called, false);
  });

  it("passes validated arguments to the handler", async () => {
    const result = await runValidated(
      (args): [string] | null => {
        const name = asBoundedString(args[0]);
        return name === null ? null : [name];
      },
      ["gitnrun"],
      (name: string) => `hello ${name}`
    );
    assert.equal(result, "hello gitnrun");
  });
});

describe("run page arguments", () => {
  it("declares the run channels", () => {
    for (const channel of ["run:overview", "run:action", "run:add-folder", "run:remove-folder", "run:set-account", "run:copy-passcode"]) {
      assert.equal(isKnownChannel(channel), true, channel);
    }
  });

  it("accepts only a target id plus a known action", () => {
    assert.deepEqual(asRunActionArgs(["p:3", "all"]), ["p:3", "all"]);
    assert.deepEqual(asRunActionArgs(["f:12", "web"]), ["f:12", "web"]);
    assert.deepEqual(asRunActionArgs(["p:3", "desktop"]), ["p:3", "desktop"]);
  });

  it("rejects extra, missing, mistyped or unknown arguments", () => {
    for (const args of [
      [],
      ["p:3"],
      ["p:3", "all", "extra"],
      ["p:3", "rm -rf /"],
      ["p:3", "ALL"],
      ["../../etc", "all"],
      ["p:0", "all"],
      [3, "all"],
      ["p:3", 1],
      [{ id: "p:3" }, "all"]
    ]) {
      assert.equal(asRunActionArgs(args), null, JSON.stringify(args));
    }
  });

  it("accepts a bare target id only in the right shape", () => {
    assert.deepEqual(asRunTargetIdArgs(["f:2"]), ["f:2"]);
    for (const args of [[], ["f:2", "x"], ["/Users/me"], [2], ["f:"]]) {
      assert.equal(asRunTargetIdArgs(args), null, JSON.stringify(args));
    }
  });

  it("accepts a target id with an account, trimmed, and an empty account to clear it", () => {
    assert.deepEqual(asRunAccountArgs(["p:3", "tester@example.com"]), ["p:3", "tester@example.com"]);
    assert.deepEqual(asRunAccountArgs(["f:2", "  alice  "]), ["f:2", "alice"]);
    assert.deepEqual(asRunAccountArgs(["p:3", ""]), ["p:3", ""]);
    assert.deepEqual(asRunAccountArgs(["p:3", "   "]), ["p:3", ""]);
    assert.deepEqual(asRunAccountArgs(["p:3", "x".repeat(200)]), ["p:3", "x".repeat(200)]);
  });

  it("rejects an account that is too long, has control characters, or comes with the wrong shape", () => {
    for (const args of [
      [],
      ["p:3"],
      ["p:3", "alice", "extra"],
      ["p:3", "x".repeat(201)],
      ["p:3", "a\nb"],
      ["p:3", "a\u0000b"],
      ["p:3", 42],
      ["p:3", null],
      ["../x", "alice"],
      ["p:0", "alice"],
      [3, "alice"]
    ]) {
      assert.equal(asRunAccountArgs(args), null, JSON.stringify(args));
    }
  });
});
