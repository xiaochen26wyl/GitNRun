import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ancestorsOf, commandMentionsFolder, describeForeign, insideFolder, parseLsofCwds, selectPortOwnership, type OwnerProcess } from "@shared/port-owner";
import type { ListeningSocket } from "@shared/port-sweep";

const FOLDER = "/work/app";
const socket = (pid: number, port: number, command = "node"): ListeningSocket => ({ pid, port, command, uid: 501 });

describe("insideFolder", () => {
  it("只認路徑邊界，/work/app 不會誤中 /work/app2", () => {
    assert.equal(insideFolder("/work/app", [FOLDER]), true);
    assert.equal(insideFolder("/work/app/services/api", [FOLDER]), true);
    assert.equal(insideFolder("/work/app2", [FOLDER]), false);
    assert.equal(insideFolder("/other/work/app", [FOLDER]), false);
    assert.equal(insideFolder("/work/app", ["/real/app", FOLDER]), true);
    assert.equal(insideFolder("/anything", [""]), false);
  });
});

describe("commandMentionsFolder", () => {
  it("命令列出現資料夾路徑且前面是路徑起點", () => {
    assert.equal(commandMentionsFolder("/work/app/node_modules/.bin/workerd serve", [FOLDER]), true);
    assert.equal(commandMentionsFolder("node --require /work/app/x.js", [FOLDER]), true);
    assert.equal(commandMentionsFolder("node /other/work/app/x.js", [FOLDER]), false);
    assert.equal(commandMentionsFolder("node /work/app2/x.js", [FOLDER]), false);
    assert.equal(commandMentionsFolder("", [FOLDER]), false);
  });
});

describe("parseLsofCwds", () => {
  it("讀出每個 pid 的工作目錄，格式不對的略過", () => {
    const output = ["p100", "fcwd", "n/work/app/services/api", "p200", "fcwd", "nrelative", "pabc", "n/x", "p300", "fcwd", "n/tmp"].join("\n");
    assert.deepEqual([...parseLsofCwds(output)], [[100, "/work/app/services/api"], [300, "/tmp"]]);
  });
});

describe("ancestorsOf", () => {
  const table: OwnerProcess[] = [
    { pid: 10, ppid: 1, command: "" },
    { pid: 20, ppid: 10, command: "" },
    { pid: 30, ppid: 20, command: "" }
  ];
  it("由自己往上追到 init 為止，遇到循環也會停", () => {
    assert.deepEqual(ancestorsOf(30, table), [30, 20, 10]);
    assert.deepEqual(ancestorsOf(30, [...table, { pid: 10, ppid: 30, command: "" }]), [30, 20, 10]);
  });
});

describe("selectPortOwnership", () => {
  const processes: OwnerProcess[] = [
    { pid: 100, ppid: 90, command: "python manage.py runserver" },
    { pid: 90, ppid: 80, command: "uv run python manage.py runserver" },
    { pid: 80, ppid: 1, command: "-zsh" },
    { pid: 500, ppid: 1, command: "node /elsewhere/scripts/dev.ts" }
  ];

  it("工作目錄在專案裡的監聽者屬於專案，其他的是別人的", () => {
    const result = selectPortOwnership({
      ports: [5175, 8000],
      sockets: [socket(100, 8000), socket(500, 5175)],
      processes,
      cwds: new Map([[100, "/work/app/services/commerce"], [500, "/elsewhere"]]),
      folders: [FOLDER]
    });
    assert.deepEqual(result.owned, [{ port: 8000, pids: [100] }]);
    assert.deepEqual(result.foreign, [{ port: 5175, pid: 500, command: "node" }]);
  });

  it("監聽者本身看不出來，但上層程序在專案資料夾裡也算專案的", () => {
    const result = selectPortOwnership({
      ports: [8000],
      sockets: [socket(100, 8000)],
      processes,
      cwds: new Map([[80, "/work/app"]]),
      folders: [FOLDER]
    });
    assert.deepEqual(result.owned, [{ port: 8000, pids: [100] }]);
  });

  it("查不到工作目錄或監聽者時一律當作別人的（fail-closed）", () => {
    const result = selectPortOwnership({ ports: [8000, 9000], sockets: [socket(100, 8000)], processes: [], cwds: new Map(), folders: [FOLDER] });
    assert.deepEqual(result.owned, []);
    assert.deepEqual(result.foreign, [{ port: 8000, pid: 100, command: "node" }, { port: 9000, pid: 0, command: "" }]);
  });

  it("說明文字：有 PID 與指令，看不到占用者時另外標示", () => {
    assert.equal(describeForeign([{ port: 5175, pid: 1709, command: "node" }, { port: 9000, pid: 0, command: "" }]), "port 5175（node PID 1709）、port 9000（無法辨識占用者）");
  });
});
