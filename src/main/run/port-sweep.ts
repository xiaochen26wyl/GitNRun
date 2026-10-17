import { execFile } from "node:child_process";
import { LSOF_ARGS, PS_ARGS, parseLsofListeners, parseProcessTable, selectSweepTargets, type PortSweepResult, type PortSweepScan, type SweepTarget } from "@shared/port-sweep";
import { UserFacingError } from "@main/errors";

/** 釋放終端機 port：掃描哪些程序占著 port，並結束它們。pid 一律由這裡掃出來，不接受畫面傳入。 */

const LSOF = "/usr/sbin/lsof";
const PS = "/bin/ps";
const EXEC_TIMEOUT_MS = 10_000;
const EXEC_MAX_BUFFER = 8 * 1024 * 1024;
const STDERR_MAX = 200;

export interface PortSweepDeps {
  exec: (file: string, args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** 程序已不存在或沒有權限時會丟錯，呼叫端不在意；結果以 isAlive 為準。 */
  kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  isAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  uid: number;
  selfPid: number;
  /** 送出 SIGTERM 後等多久才改送 SIGKILL；測試用。 */
  graceMs?: number;
  pollMs?: number;
}

export interface PortSweep {
  scan(): Promise<PortSweepScan>;
  release(): Promise<PortSweepResult>;
}

export const DEFAULT_SWEEP_GRACE_MS = 3_000;
const KILL_WAIT_MS = 1_000;
const DEFAULT_POLL_MS = 200;

export const execForOutput = (file: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(file, [...args], { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER }, (error, stdout, stderr) => {
      const exitCode: unknown = error ? (error as { code?: unknown }).code : 0;
      resolve({ code: typeof exitCode === "number" ? exitCode : 1, stdout, stderr: stderr || (error ? error.message : "") });
    });
  });

export const createPortSweep = (deps: PortSweepDeps): PortSweep => {
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const graceMs = deps.graceMs ?? DEFAULT_SWEEP_GRACE_MS;

  const scan = async (): Promise<PortSweepScan> => {
    const [listeners, table] = await Promise.all([deps.exec(LSOF, LSOF_ARGS), deps.exec(PS, PS_ARGS)]);
    // lsof 沒有任何符合的連線時以 1 結束且沒有訊息；有訊息才是真的跑不起來。
    if (listeners.code !== 0 && listeners.stderr.trim() !== "") {
      throw new UserFacingError(`無法列出 port（lsof）：${listeners.stderr.trim().slice(0, STDERR_MAX)}`);
    }
    if (table.code !== 0) {
      throw new UserFacingError(`無法讀取程序清單（ps）：${table.stderr.trim().slice(0, STDERR_MAX) || "未知錯誤"}`);
    }
    return {
      targets: selectSweepTargets({
        sockets: parseLsofListeners(listeners.stdout),
        processes: parseProcessTable(table.stdout),
        uid: deps.uid,
        selfPid: deps.selfPid
      })
    };
  };

  const signalAll = (targets: readonly SweepTarget[], signal: "SIGTERM" | "SIGKILL"): void => {
    for (const target of targets) {
      try {
        deps.kill(target.pid, signal);
      } catch {
        // 已經結束或沒有權限；是否還活著由 isAlive 判斷。
      }
    }
  };

  /** 等到全部結束或超過上限，回傳仍活著的。 */
  const waitForExit = async (targets: readonly SweepTarget[], limitMs: number): Promise<SweepTarget[]> => {
    const attempts = Math.ceil(limitMs / pollMs);
    let alive = targets.filter((target) => deps.isAlive(target.pid));
    for (let attempt = 0; alive.length > 0 && attempt < attempts; attempt += 1) {
      await deps.sleep(pollMs);
      alive = alive.filter((target) => deps.isAlive(target.pid));
    }
    return alive;
  };

  return {
    scan,

    async release() {
      const { targets } = await scan();
      if (targets.length === 0) return { ended: [], failed: [] };

      signalAll(targets, "SIGTERM");
      const stubborn = await waitForExit(targets, graceMs);
      let stuck = stubborn;
      if (stubborn.length > 0) {
        signalAll(stubborn, "SIGKILL");
        stuck = await waitForExit(stubborn, KILL_WAIT_MS);
      }
      const failedPids = new Set(stuck.map((target) => target.pid));
      return { ended: targets.filter((target) => !failedPids.has(target.pid)), failed: stuck };
    }
  };
};

/** 真實環境的組裝：process.kill、真的 sleep、目前使用者的 uid。 */
export const createSystemPortSweep = (): PortSweep =>
  createPortSweep({
    exec: execForOutput,
    kill: (pid, signal) => process.kill(pid, signal),
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        // 沒有權限代表程序還在；ESRCH 才是已結束。
        return (error as { code?: unknown }).code === "EPERM";
      }
    },
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    uid: process.getuid?.() ?? -1,
    selfPid: process.pid
  });
