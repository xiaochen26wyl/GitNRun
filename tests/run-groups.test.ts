import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RUN_GROUPS,
  countUngroupedRunTargets,
  folderNameOf,
  orderRunServiceRows,
  runGroupById,
  runGroupIdOf,
  targetsOfRunGroup
} from "@shared/run-groups";
import { groupRunServices } from "@shared/run";

const ROOT = "/Users/zorawl/Documents/GitHub";

describe("run groups", () => {
  it("places each of the ten project folders in its assigned group", () => {
    const expected: Array<[string, string]> = [
      ["Usage-Pulse", "Free"],
      ["stockPaw", "SAAS"],
      ["toBloom", "SAAS"],
      ["xiaochenStudio", "SAAS"],
      ["MahoPurr-Catalyst", "創作者宇宙"],
      ["fictionPurr", "創作者宇宙"],
      ["translationService", "創作者宇宙"],
      ["GitNRun", "Free"],
      ["socialHub", "Free"],
      ["yumeAegis", "遊戲需要美術"]
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
    assert.equal(runGroupIdOf("/somewhere/else/GitNRun/"), "open-source");
    // 只看最後一段：父層名稱剛好是別組的專案，不影響歸類。
    assert.equal(runGroupIdOf(`${ROOT}/stockPaw/GitNRun`), "open-source");
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
    assert.deepEqual(targetsOfRunGroup(targets, "open-source").map((target) => target.id), ["p:1", "p:3"]);
    assert.deepEqual(targetsOfRunGroup(targets, "saas").map((target) => target.id), ["p:2"]);
    assert.deepEqual(targetsOfRunGroup(targets, "someday"), []);
    assert.deepEqual(targetsOfRunGroup(targets, "other").map((target) => target.id), ["f:1"]);
    assert.equal(countUngroupedRunTargets(targets), 1);
    assert.equal(countUngroupedRunTargets([]), 0);
  });

  it("orders the targets of a group by the group table, whatever order they come in", () => {
    const targets = [
      { id: "a", folder: `${ROOT}/MahoPurr-Catalyst` },
      { id: "b", folder: `${ROOT}/translationservice/` },
      { id: "c", folder: `${ROOT}/FICTIONPURR` }
    ];
    assert.deepEqual(targetsOfRunGroup(targets, "creator").map((target) => target.id), ["c", "b", "a"]);
    assert.deepEqual(targets.map((target) => target.id), ["a", "b", "c"]);
  });

  it("keeps the incoming order for targets in the other group", () => {
    const targets = [
      { id: "x", folder: "/work/zeta" },
      { id: "y", folder: "/work/alpha" },
      { id: "z", folder: "/work/mid" }
    ];
    assert.deepEqual(targetsOfRunGroup(targets, "other").map((target) => target.id), ["x", "y", "z"]);
  });
});

describe("run service order", () => {
  const rowsOf = (...names: string[]) => groupRunServices(names.map((name) => ({ name })));
  const keysOf = (rows: ReturnType<typeof rowsOf>) => rows.map((row) => (row.kind === "service" ? row.service.name : `${row.kind}:${row.title}`));
  const FICTION_DECLARED = [
    "api",
    "web-fictionpurr",
    "web-sparkpurr",
    "desktop-mahopurr",
    "mobile-mahopurr-ios",
    "mobile-mahopurr-android",
    "mobile-fictionpurr-ios",
    "mobile-fictionpurr-android",
    "mobile-anipurr-ios",
    "mobile-anipurr-android",
    "mobile-poppurr-ios",
    "mobile-poppurr-android"
  ];

  it("puts the fictionPurr services in the development order, with each mobile app still one row", () => {
    const ordered = orderRunServiceRows(`${ROOT}/fictionPurr`, rowsOf(...FICTION_DECLARED));
    assert.deepEqual(keysOf(ordered), [
      "api",
      "desktop-mahopurr",
      "mobile:mobile-mahopurr",
      "web-sparkpurr",
      "mobile:mobile-fictionpurr",
      "web-fictionpurr",
      "mobile:mobile-anipurr",
      "mobile:mobile-poppurr"
    ]);
    const mahopurr = ordered[2];
    assert.deepEqual(mahopurr?.kind === "mobile" ? mahopurr.services.map((entry) => entry.platform) : [], ["ios", "android"]);
  });

  it("matches the project folder name regardless of case", () => {
    const ordered = orderRunServiceRows("/work/FICTIONPURR/", rowsOf("web-fictionpurr", "api"));
    assert.deepEqual(keysOf(ordered), ["api", "web-fictionpurr"]);
  });

  it("puts services missing from the table after the listed ones, in their original order", () => {
    const ordered = orderRunServiceRows(`${ROOT}/fictionPurr`, rowsOf("zeta", "web-sparkpurr", "alpha", "api"));
    assert.deepEqual(keysOf(ordered), ["api", "web-sparkpurr", "zeta", "alpha"]);
  });

  it("leaves projects without an order table untouched and does not mutate the input", () => {
    const rows = rowsOf("web", "api");
    assert.deepEqual(keysOf(orderRunServiceRows(`${ROOT}/toBloom`, rows)), ["web", "api"]);
    const fiction = rowsOf("web-sparkpurr", "api");
    orderRunServiceRows(`${ROOT}/fictionPurr`, fiction);
    assert.deepEqual(keysOf(fiction), ["web-sparkpurr", "api"]);
  });
});
