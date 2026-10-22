import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandInProject, describeStale, isNodeStyleCommand, parseStaleRows, selectStaleProcesses } from "@shared/stale-process";
import { createStaleProcesses } from "@main/run/stale-process";

const FOLDER = "/Users/me/Usage-Pulse";
const PS_OUTPUT = [
  `  100     1   501 ??       19:20 ${FOLDER}/node_modules/.pnpm/electron@1/Electron.app/Contents/MacOS/Electron .`,
  `  101   100   501 ??       19:20 ${FOLDER}/node_modules/.pnpm/electron@1/Helper --type=gpu-process`,
  `  200     1   501 ttys001  19:20 node ${FOLDER}/node_modules/.bin/../electron-vite/bin/electron-vite.js dev`,
  `  300     1   501 ??       19:20 /Users/me/Usage-Pulse-2/node_modules/.bin/vite`,
  `  301     1   501 ??       19:20 /Applications/Code.app/Contents/MacOS/Code ${FOLDER}`,
  `  400     1   999 ??       19:20 ${FOLDER}/node_modules/.bin/other-user`,
  `  500     1   501 ??       19:20 /Users/me/GitNRun/node_modules/electron/dist/Electron .`
].join("\n");

describe("殘留程序解析與過濾", () => {
  it("解析 ps 輸出", () => {
    const rows = parseStaleRows(PS_OUTPUT);
    assert.equal(rows.length, 7);
    assert.deepEqual(rows[0], {
      pid: 100,
      ppid: 1,
      uid: 501,
      tty: "??",
      elapsed: "19:20",
      command: `${FOLDER}/node_modules/.pnpm/electron@1/Electron.app/Contents/MacOS/Electron .`
    });
  });

  it("只挑本人、命令列含專案資料夾與 node_modules 的程序", () => {
    const rows = parseStaleRows(PS_OUTPUT);
    const picked = selectStaleProcesses({ rows, folder: FOLDER, uid: 501, selfPid: 500 });
    assert.deepEqual(picked.map((item) => item.pid), [100, 101, 200]);
  });

  it("排除 GitNRun 自己與它的上下層程序", () => {
    const rows = parseStaleRows(PS_OUTPUT);
    const picked = selectStaleProcesses({ rows, folder: FOLDER, uid: 501, selfPid: 200 });
    assert.deepEqual(picked.map((item) => item.pid), [100, 101]);
  });

  it("資料夾前面必須是路徑起點", () => {
    assert.equal(commandInProject("/x/Usage-Pulse/node_modules/a", "/Users/me/Usage-Pulse"), false);
    assert.equal(commandInProject(`node --require=${FOLDER}/node_modules/a.js`, FOLDER), true);
    assert.equal(commandInProject(`${FOLDER}/src/main.ts`, FOLDER), false);
  });

  it("說明文字截斷並標示其餘數量", () => {
    const list = Array.from({ length: 8 }, (_, index) => ({ pid: index + 2, ppid: 1, elapsed: "t", command: `${FOLDER}/node_modules/x` }));
    const text = describeStale(list, FOLDER, 3);
    assert.equal(text.split("\n").length, 4);
    assert.match(text, /另有 5 個程序/);
    assert.doesNotMatch(text, /Users\/me/);
  });

  it("只有 Node 系指令才做立即退出偵測", () => {
    assert.equal(isNodeStyleCommand(["pnpm", "dev"]), true);
    assert.equal(isNodeStyleCommand(["/usr/local/bin/node", "x.js"]), true);
    assert.equal(isNodeStyleCommand(["python", "app.py"]), false);
    assert.equal(isNodeStyleCommand([]), false);
  });
});

describe("殘留程序結束", () => {
  const make = (stubborn: ReadonlySet<number>) => {
    const killed: Array<[number, string]> = [];
    const dead = new Set<number>();
    const stale = createStaleProcesses({
      exec: async () => ({ code: 0, stdout: PS_OUTPUT, stderr: "" }),
      kill: (pid, signal) => {
        killed.push([pid, signal]);
        if (signal === "SIGKILL" || !stubborn.has(pid)) dead.add(pid);
      },
      isAlive: (pid) => !dead.has(pid),
      sleep: async () => undefined,
      uid: 501,
      selfPid: 500,
      graceMs: 2,
      pollMs: 1
    });
    return { stale, killed };
  };

  it("先 SIGTERM，沒退出的才 SIGKILL", async () => {
    const { stale, killed } = make(new Set([101]));
    const list = await stale.scan(FOLDER);
    const result = await stale.end(list);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(killed.filter(([, signal]) => signal === "SIGKILL"), [[101, "SIGKILL"]]);
    assert.equal(killed.filter(([, signal]) => signal === "SIGTERM").length, 3);
  });

  it("沒有程序時不送任何訊號", async () => {
    const { stale, killed } = make(new Set());
    assert.deepEqual(await stale.end([]), { failed: [] });
    assert.equal(killed.length, 0);
  });
});
