import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RUN_GROUPS,
  countUngroupedRunTargets,
  folderNameOf,
  runGroupById,
  runGroupIdOf,
  targetsOfRunGroup
} from "@shared/run-groups";

const ROOT = "/Users/zorawl/Documents/GitHub";

describe("run groups", () => {
  it("places each of the ten project folders in its assigned group", () => {
    const expected: Array<[string, string]> = [
      ["Usage-Pulse", "開源Free"],
      ["stockPaw", "SAAS"],
      ["toBloom", "SAAS"],
      ["xiaochenStudio", "SAAS"],
      ["MahoPurr-Catalyst", "創作者宇宙"],
      ["fictionPurr", "創作者宇宙"],
      ["translationService", "創作者宇宙"],
      ["GitNRun", "自己用"],
      ["socialHub", "自己用"],
      ["yumeAegis", "不知道什麼時候才完成"]
    ];
    for (const [name, label] of expected) {
      assert.equal(runGroupById(runGroupIdOf(`${ROOT}/${name}`)).label, label, name);
    }
  });

  it("matches folder names case-insensitively", () => {
    assert.equal(runGroupIdOf(`${ROOT}/STOCKPAW`), "saas");
    assert.equal(runGroupIdOf(`${ROOT}/usage-pulse`), "open-source");
    assert.equal(runGroupIdOf(`${ROOT}/YUMEAEGIS`), "someday");
  });

  it("uses the last path segment, ignoring trailing slashes and parent folders", () => {
    assert.equal(folderNameOf("/a/b/toBloom/"), "toBloom");
    assert.equal(folderNameOf("/a/b/toBloom//"), "toBloom");
    assert.equal(folderNameOf(""), "");
    assert.equal(folderNameOf("/"), "");
    assert.equal(runGroupIdOf("/somewhere/else/GitNRun/"), "personal");
    // 只看最後一段：父層名稱剛好是別組的專案，不影響歸類。
    assert.equal(runGroupIdOf(`${ROOT}/stockPaw/GitNRun`), "personal");
    assert.equal(runGroupIdOf(`${ROOT}/GitNRun/docs`), "other");
  });

  it("puts folders that are not in the table into other", () => {
    assert.equal(runGroupIdOf(`${ROOT}/brand-new-app`), "other");
    assert.equal(runGroupIdOf("/"), "other");
    assert.equal(runGroupById("other").label, "其他");
  });

  it("never lists the same folder name in two groups, or twice in one", () => {
    const names = RUN_GROUPS.flatMap((group) => group.folders.map((name) => name.toLowerCase()));
    assert.equal(new Set(names).size, names.length);
    assert.equal(new Set(RUN_GROUPS.map((group) => group.id)).size, RUN_GROUPS.length);
  });

  it("filters targets by group and counts the ungrouped ones", () => {
    const targets = [
      { id: "p:1", folder: `${ROOT}/GitNRun` },
      { id: "p:2", folder: `${ROOT}/toBloom` },
      { id: "f:1", folder: "/work/mystery" },
      { id: "p:3", folder: `${ROOT}/socialHub` }
    ];
    assert.deepEqual(targetsOfRunGroup(targets, "personal").map((target) => target.id), ["p:1", "p:3"]);
    assert.deepEqual(targetsOfRunGroup(targets, "saas").map((target) => target.id), ["p:2"]);
    assert.deepEqual(targetsOfRunGroup(targets, "someday"), []);
    assert.deepEqual(targetsOfRunGroup(targets, "other").map((target) => target.id), ["f:1"]);
    assert.equal(countUngroupedRunTargets(targets), 1);
    assert.equal(countUngroupedRunTargets([]), 0);
  });
});
