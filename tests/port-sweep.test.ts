import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hasTerminal,
  parseLsofListeners,
  parseProcessTable,
  protectedPids,
  selectSweepTargets,
  type ListeningSocket,
  type ProcessRow
} from "@shared/port-sweep";
import { createPortSweep } from "@main/run/port-sweep";

const LSOF = [
  "p101",
  "cnode",
  "u501",
  "f20",
  "n*:3000",
  "f21",
  "n[::1]:3000",
  "p202",
  "cPython Helper",
  "u501",
  "f4",
  "n127.0.0.1:8000",
  "p303",
  "cpostgres",
  "u501",
  "f7",
  "n[::]:5432",
  ""
].join("\n");

describe("parseLsofListeners", () => {
  it("reads pid, command, uid and port, one entry per listening socket", () => {
    assert.deepEqual(parseLsofListeners(LSOF), [
      { pid: 101, command: "node", uid: 501, port: 3000 },
      { pid: 101, command: "node", uid: 501, port: 3000 },
      { pid: 202, command: "Python Helper", uid: 501, port: 8000 },
      { pid: 303, command: "postgres", uid: 501, port: 5432 }
    ]);
  });

  it("ignores garbage, bad ports and sockets before any process line", () => {
    assert.deepEqual(parseLsofListeners(""), []);
    assert.deepEqual(parseLsofListeners("n*:3000\nfoo\n"), []);
    assert.deepEqual(parseLsofListeners("pabc\ncnode\nu1\nn*:3000\n"), []);
    assert.deepEqual(parseLsofListeners("p5\ncnode\nu1\nn*:0\nn*:70000\nn*:http\n"), []);
  });

  it("strips control characters out of the command name", () => {
    assert.equal(parseLsofListeners("p5\ncno\u001b[31mde\nu1\nn*:80\n")[0]?.command, "no[31mde");
  });
});

describe("parseProcessTable", () => {
  it("reads pid, ppid and tty, skipping malformed lines", () => {
    assert.deepEqual(parseProcessTable("    1     0 ??\n  101    55 ttys003\nbad line\n"), [
      { pid: 1, ppid: 0, tty: "??" },
      { pid: 101, ppid: 55, tty: "ttys003" }
    ]);
  });
});

describe("hasTerminal", () => {
  it("only counts real terminals", () => {
    assert.equal(hasTerminal("ttys003"), true);
    assert.equal(hasTerminal("pts/4"), true);
    assert.equal(hasTerminal("??"), false);
    assert.equal(hasTerminal("console"), false);
    assert.equal(hasTerminal(""), false);
  });
});

const TABLE: ProcessRow[] = [
  { pid: 1, ppid: 0, tty: "??" },
  { pid: 50, ppid: 1, tty: "ttys001" }, // 終端機的 shell
  { pid: 60, ppid: 50, tty: "ttys001" }, // pnpm dev（GitNRun 的上層）
  { pid: 70, ppid: 60, tty: "ttys001" }, // electron（自己）
  { pid: 71, ppid: 70, tty: "ttys001" }, // electron 子程序
  { pid: 101, ppid: 50, tty: "ttys001" }, // 手動開的 node
  { pid: 202, ppid: 50, tty: "ttys002" }, // 手動開的 python
  { pid: 303, ppid: 1, tty: "??" } // 背景 postgres
];

describe("protectedPids", () => {
  it("covers the process itself, every ancestor and every descendant, but not siblings", () => {
    assert.deepEqual([...protectedPids(TABLE, 70)].sort((a, b) => a - b), [1, 50, 60, 70, 71]);
  });

  it("survives a missing row and a parent cycle", () => {
    assert.deepEqual([...protectedPids([], 9)], [9]);
    assert.deepEqual(
      [...protectedPids([{ pid: 2, ppid: 3, tty: "x" }, { pid: 3, ppid: 2, tty: "x" }], 2)].sort(),
      [2, 3]
    );
  });
});

const socket = (pid: number, port: number, uid = 501, command = "node"): ListeningSocket => ({ pid, command, uid, port });

describe("selectSweepTargets", () => {
  it("keeps own processes started from a terminal, merges ports per process, and sorts by port", () => {
    const targets = selectSweepTargets({
      sockets: [socket(202, 8000, 501, "python"), socket(101, 5173), socket(101, 3000), socket(101, 3000)],
      processes: TABLE,
      uid: 501,
      selfPid: 70
    });
    assert.deepEqual(targets, [
      { pid: 101, command: "node", ports: [3000, 5173] },
      { pid: 202, command: "python", ports: [8000] }
    ]);
  });

  it("never selects GitNRun's own chain, other users' processes, or background services", () => {
    const targets = selectSweepTargets({
      sockets: [socket(70, 5173), socket(60, 5174), socket(71, 5175), socket(101, 3000, 0), socket(303, 5432, 501, "postgres"), socket(1, 80), socket(999, 9999)],
      processes: TABLE,
      uid: 501,
      selfPid: 70
    });
    assert.deepEqual(targets, []);
  });
});

describe("port sweep release", () => {
  const harness = (options: { table?: ProcessRow[]; survivors?: Set<number>; stubborn?: Set<number>; lsof?: string } = {}) => {
    const alive = new Set([101, 202]);
    const signals: string[] = [];
    const sweep = createPortSweep({
      exec: async (file) => ({
        code: 0,
        stderr: "",
        stdout: file.endsWith("lsof") ? (options.lsof ?? LSOF) : "    1     0 ??\n  101    50 ttys001\n  202    50 ttys002\n  303     1 ??\n"
      }),
      kill: (pid, signal) => {
        signals.push(`${signal}:${pid}`);
        if (signal === "SIGKILL" || !options.stubborn?.has(pid)) alive.delete(pid);
      },
      isAlive: (pid) => alive.has(pid),
      sleep: async () => undefined,
      uid: 501,
      selfPid: 70
    });
    return { sweep, signals, alive };
  };

  it("scans without signalling anything", async () => {
    const h = harness();
    const scan = await h.sweep.scan();
    assert.deepEqual(
      scan.targets.map((target) => target.pid),
      [101, 202]
    );
    assert.deepEqual(h.signals, []);
  });

  it("ends only what the scan selects, politely first", async () => {
    const h = harness();
    const result = await h.sweep.release();
    assert.deepEqual(h.signals, ["SIGTERM:101", "SIGTERM:202"]);
    assert.deepEqual(result.ended.map((target) => target.pid), [101, 202]);
    assert.deepEqual(result.failed, []);
  });

  it("falls back to SIGKILL for a process that ignores SIGTERM, and reports one that survives even that", async () => {
    const h = harness({ stubborn: new Set([202]) });
    const result = await h.sweep.release();
    assert.deepEqual(h.signals, ["SIGTERM:101", "SIGTERM:202", "SIGKILL:202"]);
    assert.deepEqual(result.ended.map((target) => target.pid), [101, 202]);

    const never = createPortSweep({
      exec: async (file) => ({ code: 0, stderr: "", stdout: file.endsWith("lsof") ? LSOF : "  101    50 ttys001\n" }),
      kill: () => undefined,
      isAlive: () => true,
      sleep: async () => undefined,
      uid: 501,
      selfPid: 70
    });
    const stuck = await never.release();
    assert.deepEqual(stuck.ended, []);
    assert.deepEqual(stuck.failed.map((target) => target.pid), [101]);
  });

  it("does nothing when no terminal port is open", async () => {
    const h = harness({ lsof: "" });
    assert.deepEqual(await h.sweep.release(), { ended: [], failed: [] });
    assert.deepEqual(h.signals, []);
  });

  it("fails loudly when lsof itself cannot run, instead of pretending nothing is open", async () => {
    const sweep = createPortSweep({
      exec: async () => ({ code: 127, stderr: "lsof: command not found", stdout: "" }),
      kill: () => undefined,
      isAlive: () => false,
      sleep: async () => undefined,
      uid: 501,
      selfPid: 70
    });
    await assert.rejects(sweep.scan(), /lsof/);
  });
});
