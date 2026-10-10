import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DryRunReport } from "@shared/rule-runs";
import { createRule, listRules } from "@main/db/rules-repo";
import { addProject } from "@main/db/projects-repo";
import { UserFacingError } from "@main/errors";
import {
  MAX_RULES_FILE_BYTES,
  RULES_FILE_FORMAT,
  createRulesHandlers
} from "@main/rules/handlers";
import { createVault } from "@main/vault/vault";
import { createTestDb, storeEvent } from "./helpers/db";
import { createFakeCipher } from "./helpers/fake-cipher";

const good = { name: "notify", actions: [{ type: "notify_system" }] };

const setup = () => {
  const db = createTestDb();
  const vault = createVault(db, createFakeCipher());
  const dryRuns: unknown[] = [];
  const state = { changed: 0 };
  const handlers = createRulesHandlers({
    db,
    vault,
    onConfigChanged: () => void (state.changed += 1),
    engine: {
      dryRun: async (rule, event) => {
        dryRuns.push([rule.name, event.id]);
        return { matched: true, conditions: [], actions: [] } as DryRunReport;
      },
      previewMatches: (rule) => ({ examined: 1, matchedEventIds: rule.name === "match" ? [1] : [] })
    }
  });
  const project = addProject(db, {
    owner: "acme", repo: "api", name: "acme/api", localPath: null,
    branchFilter: ["*"], pollIntervalSec: 30, mode: "poll", enabled: true, aiEnabled: false
  });
  return { db, vault, handlers, dryRuns, state, project };
};

describe("create / update / delete", () => {
  it("validates input and explains what is wrong", () => {
    const { handlers } = setup();
    assert.throws(() => handlers.create({ name: "", actions: [] }), (error) => error instanceof UserFacingError && error.message.includes("名稱"));
    assert.throws(() => handlers.create({ ...good, actions: [{ type: "rm_rf" }] }), UserFacingError);
    assert.equal(handlers.list().length, 0);
  });

  it("creates, updates and deletes, scheduling a config backup each time", () => {
    const { handlers, state } = setup();
    const rule = handlers.create(good);
    assert.equal(handlers.list().length, 1);

    const updated = handlers.update(rule.id, { ...good, name: "renamed", priority: 5 });
    assert.equal(updated.name, "renamed");

    handlers.remove(rule.id);
    assert.equal(handlers.list().length, 0);
    assert.equal(state.changed, 3);
  });

  it("rejects updating a missing rule and tolerates deleting one", () => {
    const { handlers } = setup();
    assert.throws(() => handlers.update(999, good), UserFacingError);
    assert.throws(() => handlers.setEnabled(999, true), UserFacingError);
    assert.doesNotThrow(() => handlers.remove(999));
  });

  it("toggles enabled", () => {
    const { handlers } = setup();
    const rule = handlers.create(good);
    assert.equal(handlers.setEnabled(rule.id, false).enabled, false);
    assert.equal(handlers.setEnabled(rule.id, true).enabled, true);
  });
});

describe("secret environment variables belong to their rule", () => {
  const shell = (secretEnvNames: string[]) => ({
    name: "deploy",
    actions: [{ type: "shell", command: "deploy.sh", secretEnvNames }]
  });

  it("are removed from the vault when the rule is deleted", () => {
    const { handlers, vault } = setup();
    const rule = handlers.create(shell(["API_TOKEN", "DEPLOY_KEY"]));
    vault.set(`env.${rule.id}.API_TOKEN`, "token-value-1234567");
    vault.set(`env.${rule.id}.DEPLOY_KEY`, "key-value-1234567");
    vault.set("github.pat", "github_pat_unrelated_value_123");

    handlers.remove(rule.id);

    assert.equal(vault.has(`env.${rule.id}.API_TOKEN`), false);
    assert.equal(vault.has(`env.${rule.id}.DEPLOY_KEY`), false);
    assert.equal(vault.has("github.pat"), true, "unrelated secrets are untouched");
  });

  it("are removed when the rule stops declaring them", () => {
    const { handlers, vault } = setup();
    const rule = handlers.create(shell(["API_TOKEN", "DEPLOY_KEY"]));
    vault.set(`env.${rule.id}.API_TOKEN`, "token-value-1234567");
    vault.set(`env.${rule.id}.DEPLOY_KEY`, "key-value-1234567");

    handlers.update(rule.id, shell(["API_TOKEN"]));

    assert.equal(vault.has(`env.${rule.id}.API_TOKEN`), true);
    assert.equal(vault.has(`env.${rule.id}.DEPLOY_KEY`), false);
  });

  it("another rule's secrets are never touched", () => {
    const { handlers, vault } = setup();
    const a = handlers.create(shell(["TOKEN"]));
    const b = handlers.create(shell(["TOKEN"]));
    vault.set(`env.${a.id}.TOKEN`, "a-token-value-12345");
    vault.set(`env.${b.id}.TOKEN`, "b-token-value-12345");

    handlers.remove(a.id);

    assert.equal(vault.has(`env.${b.id}.TOKEN`), true);
  });
});

describe("reorder", () => {
  it("renumbers in the given order", () => {
    const { handlers } = setup();
    const a = handlers.create({ ...good, name: "a" });
    const b = handlers.create({ ...good, name: "b" });
    const c = handlers.create({ ...good, name: "c" });

    const reordered = handlers.reorder([c.id, a.id, b.id]);

    assert.deepEqual(reordered.map((rule) => rule.name), ["c", "a", "b"]);
  });

  it("refuses a list that does not match the current rules", () => {
    const { handlers } = setup();
    const a = handlers.create({ ...good, name: "a" });
    handlers.create({ ...good, name: "b" });
    assert.throws(() => handlers.reorder([a.id]), UserFacingError);
    assert.throws(() => handlers.reorder([a.id, a.id]), UserFacingError);
    assert.throws(() => handlers.reorder([a.id, 999]), UserFacingError);
  });
});

describe("preview and dry run", () => {
  it("previews with validation", () => {
    const { handlers } = setup();
    assert.deepEqual(handlers.preview({ ...good, name: "match" }).matchedEventIds, [1]);
    assert.throws(() => handlers.preview({ name: "" }), UserFacingError);
  });

  it("dry-runs against a stored event, and reports an unknown event", async () => {
    const { db, handlers, dryRuns, project } = setup();
    const event = storeEvent(db, project.id);

    await handlers.dryRun(good, event.id);
    assert.deepEqual(dryRuns, [["notify", event.id]]);
    await assert.rejects(handlers.dryRun(good, 9999), UserFacingError);
    await assert.rejects(handlers.dryRun({ name: "" }, event.id), UserFacingError);
  });

  it("lists executions", () => {
    const { db, handlers, project } = setup();
    const rule = createRule(db, { ...good, enabled: true, priority: 1, matchMode: "all", conditions: [], actions: [{ type: "notify_system" }], cooldownSec: 0, skipConfirm: false });
    const event = storeEvent(db, project.id);
    db.prepare("INSERT INTO rule_executions (rule_id, rule_name, event_id, status, started_at) VALUES (?, 'notify', ?, 'success', 5)").run(rule.id, event.id);

    assert.equal(handlers.executions().length, 1);
    assert.equal(handlers.executions(rule.id).length, 1);
    assert.equal(handlers.executions(999).length, 0);
  });
});

describe("export and import", () => {
  const rich = {
    name: "deploy",
    enabled: true,
    skipConfirm: true,
    actions: [{ type: "shell", command: "deploy.sh", secretEnvNames: ["API_TOKEN"], env: [{ name: "STAGE", value: "prod" }] }]
  };

  it("exports rules without ids and without any secret values", () => {
    const { handlers, vault } = setup();
    const rule = handlers.create(rich);
    vault.set(`env.${rule.id}.API_TOKEN`, "super-secret-token-value");

    const text = handlers.exportText();
    const file = JSON.parse(text);

    assert.equal(file.format, RULES_FILE_FORMAT);
    assert.equal(file.rules.length, 1);
    assert.equal(file.rules[0].id, undefined);
    assert.deepEqual(file.rules[0].actions[0].secretEnvNames, ["API_TOKEN"]);
    assert.ok(!text.includes("super-secret-token-value"));
  });

  it("imports into another database as DISABLED rules that need confirmation", () => {
    const source = setup();
    source.handlers.create(rich);
    const text = source.handlers.exportText();

    const target = setup();
    const result = target.handlers.importText(text);

    assert.deepEqual(result, { imported: 1, renamed: 0 });
    const [imported] = listRules(target.db);
    assert.equal(imported?.enabled, false, "an imported rule does not start running by itself");
    assert.equal(imported?.skipConfirm, false, "an imported file cannot switch the confirmation gate off");
    assert.equal(imported?.name, "deploy");
  });

  it("renames on a name clash instead of overwriting", () => {
    const t = setup();
    t.handlers.create({ ...good, name: "same" });
    const text = JSON.stringify({ format: RULES_FILE_FORMAT, version: 1, rules: [{ ...good, name: "same" }, { ...good, name: "same" }] });

    assert.deepEqual(t.handlers.importText(text), { imported: 2, renamed: 2 });
    assert.deepEqual(listRules(t.db).map((rule) => rule.name).sort(), ["same", "same (2)", "same (3)"]);
  });

  it("is all-or-nothing: one bad rule rejects the whole file", () => {
    const t = setup();
    const text = JSON.stringify({ format: RULES_FILE_FORMAT, version: 1, rules: [good, { name: "bad", actions: [{ type: "format_disk" }] }] });

    assert.throws(() => t.handlers.importText(text), (error) => error instanceof UserFacingError && error.message.includes("規則 2"));
    assert.equal(listRules(t.db).length, 0);
  });

  it("rejects files that are not rule exports", () => {
    const t = setup();
    for (const text of [
      "not json",
      "[]",
      "null",
      JSON.stringify({ format: "something-else", version: 1, rules: [good] }),
      JSON.stringify({ format: RULES_FILE_FORMAT, version: 2, rules: [good] }),
      JSON.stringify({ format: RULES_FILE_FORMAT, version: 1, rules: [] }),
      JSON.stringify({ format: RULES_FILE_FORMAT, version: 1, rules: "x" }),
      JSON.stringify({ format: RULES_FILE_FORMAT, version: 1, rules: Array(201).fill(good) }),
      " ".repeat(MAX_RULES_FILE_BYTES + 1)
    ]) {
      assert.throws(() => t.handlers.importText(text), UserFacingError, text.slice(0, 40));
    }
    assert.equal(listRules(t.db).length, 0);
  });
});
