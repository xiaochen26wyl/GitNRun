import { STALE_PS_ARGS, parseStaleRows, selectStaleProcesses, type StaleProcess } from "@shared/stale-process";
import { execForOutput } from "@main/run/port-sweep";

/** 殘留程序：掃描專案資料夾下還活著的開發程序並結束。pid 一律由這裡掃出來，不接受畫面傳入。 */

const PS = "/bin/ps";
const DEFAULT_GRACE_MS = 3_000;
const KILL_WAIT_MS = 1_000;
const DEFAULT_POLL_MS = 200;

export interface StaleProcesses {
  scan(folder: string): Promise<StaleProcess[]>;
  end(list: readonly StaleProcess[]): Promise<{ failed: StaleProcess[] }>;
}

export interface StaleProcessDeps {
  exec: (file: string, args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  isAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  uid: number;
  selfPid: number;
  graceMs?: number;
  pollMs?: number;
}

export const createStaleProcesses = (deps: StaleProcessDeps): StaleProcesses => {
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const graceMs = deps.graceMs ?? DEFAULT_GRACE_MS;

  const signalAll = (list: readonly StaleProcess[], signal: "SIGTERM" | "SIGKILL"): void => {
    for (const item of list) {
      try {
        deps.kill(item.pid, signal);
      } catch {
        // 已經結束或沒有權限；是否還活著由 isAlive 判斷。
      }
    }
  };

  const waitForExit = async (list: readonly StaleProcess[], limitMs: number): Promise<StaleProcess[]> => {
    const attempts = Math.ceil(limitMs / pollMs);
    let alive = list.filter((item) => deps.isAlive(item.pid));
    for (let attempt = 0; alive.length > 0 && attempt < attempts; attempt += 1) {
      await deps.sleep(pollMs);
      alive = alive.filter((item) => deps.isAlive(item.pid));
    }
    return alive;
  };

  return {
    async scan(folder) {
      const table = await deps.exec(PS, STALE_PS_ARGS);
      if (table.code !== 0) throw new Error(table.stderr.trim().slice(0, 200) || "無法讀取程序清單");
      return selectStaleProcesses({ rows: parseStaleRows(table.stdout), folder, uid: deps.uid, selfPid: deps.selfPid });
    },

    async end(list) {
      if (list.length === 0) return { failed: [] };
      signalAll(list, "SIGTERM");
      const stubborn = await waitForExit(list, graceMs);
      if (stubborn.length === 0) return { failed: [] };
      signalAll(stubborn, "SIGKILL");
      return { failed: await waitForExit(stubborn, KILL_WAIT_MS) };
    }
  };
};

export const createSystemStaleProcesses = (): StaleProcesses =>
  createStaleProcesses({
    exec: execForOutput,
    kill: (pid, signal) => process.kill(pid, signal),
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as { code?: unknown }).code === "EPERM";
      }
    },
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    uid: process.getuid?.() ?? -1,
    selfPid: process.pid
  });
