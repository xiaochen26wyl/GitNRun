import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultAction,
  defaultCondition,
  emptyRule,
  envToLines,
  linesToList,
  moveItem,
  parseEnvLines,
  parseNameList
} from "@shared/rule-defaults";
import { ACTION_TYPES, CONDITION_TYPES, validateRuleInput } from "@shared/rules";

describe("editor defaults", () => {
  it("every condition type has a default, and the ones that need no input already validate", () => {
    for (const type of CONDITION_TYPES) {
      const condition = defaultCondition(type);
      assert.equal(condition.type, type);
      const result = validateRuleInput({ ...emptyRule(), name: "x", conditions: [condition] });
      if (type === "pusher" || type === "project") {
        assert.ok(!result.ok, `${type} needs the user to fill something in`);
      } else {
        assert.ok(result.ok, `${type}: ${JSON.stringify(result)}`);
      }
    }
  });

  it("every action type has a default; incomplete ones are rejected rather than silently saved", () => {
    const needsInput = new Set(["notify_webhook", "notify_email", "shell"]);
    for (const type of ACTION_TYPES) {
      const action = defaultAction(type);
      assert.equal(action.type, type);
      const result = validateRuleInput({ ...emptyRule(), name: "x", actions: [action] });
      assert.equal(result.ok, !needsInput.has(type), `${type}: ${JSON.stringify(result)}`);
    }
  });

  it("a fresh rule needs only a name", () => {
    assert.ok(!validateRuleInput(emptyRule()).ok);
    assert.ok(validateRuleInput({ ...emptyRule(), name: "my rule" }).ok);
    assert.equal(emptyRule().skipConfirm, false, "confirmation is on unless the user turns it off");
  });
});

describe("text conversion", () => {
  it("turns lines into a clean list", () => {
    assert.deepEqual(linesToList(" a \n\n  b\n   \n"), ["a", "b"]);
    assert.deepEqual(linesToList(""), []);
  });

  it("parses NAME=value lines, keeping '=' inside values", () => {
    assert.deepEqual(parseEnvLines("FOO=bar\n\n URL = a=b=c \nNOEQ"), [
      { name: "FOO", value: "bar" },
      { name: "URL", value: " a=b=c" },
      { name: "NOEQ", value: "" }
    ]);
    assert.equal(envToLines([{ name: "A", value: "1" }, { name: "B", value: "2" }]), "A=1\nB=2");
  });

  it("parses comma or newline separated names", () => {
    assert.deepEqual(parseNameList("A, B\nC ,, "), ["A", "B", "C"]);
  });
});

describe("moveItem", () => {
  it("swaps neighbours and ignores out-of-range moves", () => {
    assert.deepEqual(moveItem([1, 2, 3], 1, -1), [2, 1, 3]);
    assert.deepEqual(moveItem([1, 2, 3], 1, 1), [1, 3, 2]);
    assert.deepEqual(moveItem([1, 2, 3], 0, -1), [1, 2, 3]);
    assert.deepEqual(moveItem([1, 2, 3], 2, 1), [1, 2, 3]);
    assert.deepEqual(moveItem([1, 2, 3], 9, 1), [1, 2, 3]);
  });

  it("does not mutate its input", () => {
    const original = [1, 2, 3];
    moveItem(original, 0, 1);
    assert.deepEqual(original, [1, 2, 3]);
  });
});

import { COMMAND_PRESETS } from "@shared/command-presets";

describe("command presets", () => {
  it("have unique ids and are all usable as shell commands in a rule", () => {
    assert.equal(new Set(COMMAND_PRESETS.map((preset) => preset.id)).size, COMMAND_PRESETS.length);
    for (const preset of COMMAND_PRESETS) {
      const action = { ...defaultAction("shell"), command: preset.command };
      assert.ok(validateRuleInput({ ...emptyRule(), name: "x", actions: [action] }).ok, preset.id);
    }
  });
});
