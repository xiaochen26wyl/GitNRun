import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IPC } from "@shared/ipc";
import {
  asBooleanArgs,
  asBranchRuleSaveArgs,
  asScopeIdArgs,
  asStartWorkInput,
  asStartWorkPreviewArgs,
  asStartWorkRunArgs,
  asEventQuery,
  asEventQueryArgs,
  asIdArgs,
  asLogQuery,
  asProjectInputArgs,
  asProjectUpdateArgs,
  isKnownChannel
} from "@main/ipc-validation";

describe("new channels are declared", () => {
  it("recognises every project, event, log and monitor channel", () => {
    for (const channel of Object.values(IPC)) {
      assert.equal(isKnownChannel(channel), true, channel);
    }
  });
});

describe("asEventQuery", () => {
  it("accepts an empty query and all supported fields", () => {
    assert.deepEqual(asEventQuery({}), {});
    const full = {
      projectId: 3, branch: "main", pusher: "alice", fromMs: 1, toMs: 2,
      search: "login", branchViolationOnly: true, limit: 50, offset: 100
    };
    assert.deepEqual(asEventQuery(full), full);
  });

  it("rejects unknown keys, wrong types and out-of-range values", () => {
    for (const bad of [
      null, [], "x", 5,
      { sql: "1=1" },
      { projectId: 0 },
      { projectId: "3" },
      { branch: "" },
      { branch: "x".repeat(201) },
      { search: "a\nb" },
      { fromMs: -1 },
      { toMs: 1.5 },
      { branchViolationOnly: "yes" },
      { limit: 0 },
      { limit: 201 },
      { offset: -1 },
      Object.create({ projectId: 1 })
    ]) {
      assert.equal(asEventQuery(bad), null, JSON.stringify(bad));
    }
  });

  it("asEventQueryArgs needs exactly one argument", () => {
    assert.deepEqual(asEventQueryArgs([{ limit: 5 }]), [{ limit: 5 }]);
    assert.equal(asEventQueryArgs([]), null);
    assert.equal(asEventQueryArgs([{}, {}]), null);
  });
});

describe("asLogQuery", () => {
  it("accepts known categories and levels only", () => {
    assert.deepEqual(asLogQuery({ category: "rule", level: "warn", limit: 500 }), { category: "rule", level: "warn", limit: 500 });
    assert.equal(asLogQuery({ category: "other" }), null);
    assert.equal(asLogQuery({ level: "fatal" }), null);
    assert.equal(asLogQuery({ limit: 501 }), null);
    assert.equal(asLogQuery({ extra: 1 }), null);
  });
});

describe("id and boolean arguments", () => {
  it("accepts one positive integer id", () => {
    assert.deepEqual(asIdArgs([5]), [5]);
    for (const bad of [[], [0], [-1], [1.5], ["5"], [5, 6], [null], [2 ** 31]]) {
      assert.equal(asIdArgs(bad), null, JSON.stringify(bad));
    }
  });

  it("accepts exactly one boolean", () => {
    assert.deepEqual(asBooleanArgs([true]), [true]);
    assert.equal(asBooleanArgs(["true"]), null);
    assert.equal(asBooleanArgs([]), null);
  });
});

describe("project arguments", () => {
  it("normalises a new project and rejects bad ones", () => {
    const ok = asProjectInputArgs([{ owner: "acme", repo: "widgets" }]);
    assert.equal(ok?.[0].name, "acme/widgets");
    assert.equal(asProjectInputArgs([{ owner: "..", repo: "x" }]), null);
    assert.equal(asProjectInputArgs([]), null);
    assert.equal(asProjectInputArgs(["acme/widgets"]), null);
  });

  it("allows patching only mutable fields", () => {
    assert.deepEqual(asProjectUpdateArgs([3, { enabled: false }]), [3, { enabled: false }]);
    assert.equal(asProjectUpdateArgs([3, { owner: "evil" }]), null);
    assert.equal(asProjectUpdateArgs([3, { repo: "evil" }]), null);
    assert.equal(asProjectUpdateArgs([3, { id: 9 }]), null);
    assert.equal(asProjectUpdateArgs([0, {}]), null);
    assert.equal(asProjectUpdateArgs([3]), null);
    assert.equal(asProjectUpdateArgs([3, []]), null);
  });
});

describe("branch rule and start-work arguments", () => {
  it("accepts scope 0 (global) and project ids, nothing else", () => {
    assert.deepEqual(asScopeIdArgs([0]), [0]);
    assert.deepEqual(asScopeIdArgs([12]), [12]);
    for (const bad of [[], [-1], [1.5], ["0"], [0, 1], [2 ** 31]]) {
      assert.equal(asScopeIdArgs(bad), null, JSON.stringify(bad));
    }
  });

  it("branch rule save needs a scope and a plain object (content is validated by the handler)", () => {
    assert.deepEqual(asBranchRuleSaveArgs([0, { template: "x" }]), [0, { template: "x" }]);
    assert.equal(asBranchRuleSaveArgs([0]), null);
    assert.equal(asBranchRuleSaveArgs([0, []]), null);
    assert.equal(asBranchRuleSaveArgs([-1, {}]), null);
    assert.equal(asBranchRuleSaveArgs([0, "x"]), null);
  });

  it("start-work input only allows bounded type and slug", () => {
    assert.deepEqual(asStartWorkInput({}), {});
    assert.deepEqual(asStartWorkInput({ type: "feat", slug: "login page" }), { type: "feat", slug: "login page" });
    for (const bad of [null, "x", [], { type: 5 }, { slug: "a\nb" }, { type: "x".repeat(13) }, { slug: "x".repeat(201) }, { extra: 1 }]) {
      assert.equal(asStartWorkInput(bad), null, JSON.stringify(bad));
    }
  });

  it("preview needs a project id and input; run additionally needs the expected branch name", () => {
    assert.deepEqual(asStartWorkPreviewArgs([3, {}]), [3, {}]);
    assert.equal(asStartWorkPreviewArgs([0, {}]), null);
    assert.equal(asStartWorkPreviewArgs([3]), null);

    assert.deepEqual(asStartWorkRunArgs([3, { slug: "x" }, "feature/x"]), [3, { slug: "x" }, "feature/x"]);
    assert.equal(asStartWorkRunArgs([3, {}]), null);
    assert.equal(asStartWorkRunArgs([3, {}, ""]), null);
    assert.equal(asStartWorkRunArgs([3, {}, "a".repeat(256)]), null);
    assert.equal(asStartWorkRunArgs([3, {}, 5]), null);
  });
});
