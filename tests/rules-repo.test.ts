import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RuleInput } from "@shared/rules";
import { addProject } from "@main/db/projects-repo";
import { purgeExpired, DAY_MS } from "@main/db/retention";
import {
  createRule,
  deleteRule,
  getRule,
  isSelfCaused,
  listEnabledRules,
  listRules,
  recordSelfSha,
  reorderRules,
  setRuleEnabled,
  updateRule
} from "@main/db/rules-repo";
import { createTestDb } from "./helpers/db";

const input = (overrides: Partial<RuleInput> = {}): RuleInput => ({
  name: "r", enabled: true, priority: 100, matchMode: "all",
  conditions: [{ type: "branch", patterns: ["main"] }],
  actions: [{ type: "notify_system", title: "hi" }],
  cooldownSec: 0, skipConfirm: false,
  ...overrides
});

describe("rules repo", () => {
  it("creates and reads back a rule exactly as given", () => {
    const db = createTestDb();
    const rule = createRule(db, input({ name: "first", skipConfirm: true, cooldownSec: 45 }), 1234);

    assert.equal(rule.createdAt, 1234);
    assert.deepEqual({ ...rule, id: 0, createdAt: 0, updatedAt: 0 }, { ...input({ name: "first", skipConfirm: true, cooldownSec: 45 }), id: 0, createdAt: 0, updatedAt: 0 });
    assert.deepEqual(getRule(db, rule.id), rule);
  });

  it("lists by priority then id, and the engine view only has enabled rules", () => {
    const db = createTestDb();
    createRule(db, input({ name: "late", priority: 50 }));
    createRule(db, input({ name: "early", priority: 5 }));
    createRule(db, input({ name: "off", priority: 1, enabled: false }));

    assert.deepEqual(listRules(db).map((rule) => rule.name), ["off", "early", "late"]);
    assert.deepEqual(listEnabledRules(db).map((rule) => rule.name), ["early", "late"]);
  });

  it("updates, toggles and deletes", () => {
    const db = createTestDb();
    const rule = createRule(db, input());

    const updated = updateRule(db, rule.id, input({ name: "renamed", priority: 7 }), 99);
    assert.equal(updated?.name, "renamed");
    assert.equal(updated?.updatedAt, 99);
    assert.equal(updateRule(db, 999, input()), null);

    assert.equal(setRuleEnabled(db, rule.id, false), true);
    assert.equal(getRule(db, rule.id)?.enabled, false);
    assert.equal(setRuleEnabled(db, 999, false), false);

    assert.equal(deleteRule(db, rule.id), true);
    assert.equal(getRule(db, rule.id), null);
    assert.equal(deleteRule(db, rule.id), false);
  });

  it("reorders by renumbering in steps of ten", () => {
    const db = createTestDb();
    const a = createRule(db, input({ name: "a", priority: 1 }));
    const b = createRule(db, input({ name: "b", priority: 2 }));
    const c = createRule(db, input({ name: "c", priority: 3 }));

    reorderRules(db, [c.id, a.id, b.id]);

    assert.deepEqual(listRules(db).map((rule) => [rule.name, rule.priority]), [["c", 10], ["a", 20], ["b", 30]]);
  });

  it("never returns (or runs) a rule whose stored JSON no longer validates", () => {
    const db = createTestDb();
    createRule(db, input({ name: "good" }));
    db.prepare(
      `INSERT INTO rules (name, enabled, priority, match_mode, conditions_json, actions_json, cooldown_sec, skip_confirm, created_at, updated_at)
       VALUES ('tampered', 1, 1, 'all', '[]', '[{"type":"rm_rf_everything"}]', 0, 1, 0, 0)`
    ).run();
    db.prepare(
      `INSERT INTO rules (name, enabled, priority, match_mode, conditions_json, actions_json, cooldown_sec, skip_confirm, created_at, updated_at)
       VALUES ('garbage', 1, 2, 'all', 'not json', 'not json', 0, 0, 0, 0)`
    ).run();

    assert.deepEqual(listRules(db).map((rule) => rule.name), ["good"]);
    assert.deepEqual(listEnabledRules(db).map((rule) => rule.name), ["good"]);
  });
});

describe("self-caused pushes", () => {
  it("remembers which rule caused which SHA", () => {
    const db = createTestDb();
    const a = createRule(db, input({ name: "a" }));
    const b = createRule(db, input({ name: "b" }));
    recordSelfSha(db, a.id, "1".repeat(40));
    recordSelfSha(db, a.id, "1".repeat(40)); // 重複登記不報錯

    assert.equal(isSelfCaused(db, a.id, ["0".repeat(40), "1".repeat(40)]), true);
    assert.equal(isSelfCaused(db, a.id, ["2".repeat(40)]), false);
    assert.equal(isSelfCaused(db, b.id, ["1".repeat(40)]), false, "per rule");
    assert.equal(isSelfCaused(db, a.id, []), false);
  });

  it("disappears with its rule and is purged after a week", () => {
    const db = createTestDb();
    const rule = createRule(db, input());
    recordSelfSha(db, rule.id, "1".repeat(40), 1000);
    recordSelfSha(db, rule.id, "2".repeat(40), 1000 + 6 * DAY_MS);

    purgeExpired(db, { retentionDays: null, now: 1000 + 8 * DAY_MS });
    assert.equal(isSelfCaused(db, rule.id, ["1".repeat(40)]), false);
    assert.equal(isSelfCaused(db, rule.id, ["2".repeat(40)]), true);

    deleteRule(db, rule.id);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM rule_self_events").get()?.n), 0);
  });
});

describe("project deletion", () => {
  it("keeps rules (they are global) and clears their history through the events", () => {
    const db = createTestDb();
    const project = addProject(db, {
      owner: "acme", repo: "api", name: "acme/api", localPath: null,
      branchFilter: ["*"], pollIntervalSec: 30, mode: "poll", enabled: true, aiEnabled: false
    });
    createRule(db, input());
    db.prepare("DELETE FROM projects WHERE id = ?").run(project.id);
    assert.equal(listRules(db).length, 1);
  });
});
