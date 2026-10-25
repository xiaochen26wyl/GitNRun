import { realpath } from "node:fs/promises";
import { LSOF_ARGS, parseLsofListeners } from "@shared/port-sweep";
import { ancestorsOf, lsofCwdArgs, parseLsofCwds, selectPortOwnership, type OwnerProcess, type PortOwnership } from "@shared/port-owner";
import { STALE_PS_ARGS, parseStaleRows } from "@shared/stale-process";
import { execForOutput } from "@main/run/port-sweep";

/** 專案內釋放 port：查出每個 port 的監聽者，只認屬於該專案資料夾的程序。pid 一律由這裡掃出來，不接受畫面傳入。 */

const LSOF = "/usr/sbin/lsof";
const PS = "/bin/ps";

export interface PortOwnersDeps {
  exec: (file: string, args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  realpath: (path: string) => Promise<string>;
  kill: (pid: number, signal: "SIGTERM") => void;
}

export interface PortOwners {
  resolve(folder: string, ports: readonly number[]): Promise<PortOwnership>;
  /** 只對屬於該專案的監聽程序送結束訊號；別的程式占用的 port 一律不動。 */
  stop(folder: string, ports: readonly number[]): Promise<{ code: number; stderr: string }>;
}

export const createPortOwners = (deps: PortOwnersDeps): PortOwners => {
  const resolve = async (folder: string, ports: readonly number[]): Promise<PortOwnership> => {
    if (ports.length === 0) return { owned: [], foreign: [] };
    const [listeners, table] = await Promise.all([deps.exec(LSOF, LSOF_ARGS), deps.exec(PS, STALE_PS_ARGS)]);
    const wanted = new Set(ports);
    const sockets = parseLsofListeners(listeners.stdout).filter((socket) => wanted.has(socket.port));
    const processes: OwnerProcess[] = parseStaleRows(table.stdout).map(({ pid, ppid, command }) => ({ pid, ppid, command }));

    const pids = new Set<number>();
    for (const socket of sockets) for (const pid of ancestorsOf(socket.pid, processes)) pids.add(pid);
    const cwdOutput = pids.size > 0 ? await deps.exec(LSOF, lsofCwdArgs([...pids].sort((a, b) => a - b))) : { stdout: "" };
    const real = await deps.realpath(folder).catch(() => folder);

    return selectPortOwnership({ ports, sockets, processes, cwds: parseLsofCwds(cwdOutput.stdout), folders: [...new Set([folder, real])] });
  };

  return {
    resolve,
    async stop(folder, ports) {
      const { owned } = await resolve(folder, ports);
      const failed: number[] = [];
      for (const pid of owned.flatMap((item) => item.pids)) {
        try {
          deps.kill(pid, "SIGTERM");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") failed.push(pid);
        }
      }
      return failed.length === 0 ? { code: 0, stderr: "" } : { code: 1, stderr: `無法結束 PID ${failed.join("、")}` };
    }
  };
};

export const createSystemPortOwners = (): PortOwners =>
  createPortOwners({ exec: execForOutput, realpath: (path) => realpath(path), kill: (pid, signal) => process.kill(pid, signal) });
