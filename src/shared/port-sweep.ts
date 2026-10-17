/**
 * 釋放終端機 port：lsof、ps 輸出的解析與「哪些程序該被結束」的過濾（純函式）。
 *
 * 只處理同時符合三個條件的程序：本人擁有、有控制終端機（在終端機手動開的）、不是 GitNRun 自己和它的上下層程序。
 * 沒有終端機的背景服務（資料庫、Docker、系統程序）一律不碰。
 */

export interface ListeningSocket {
  pid: number;
  command: string;
  uid: number;
  port: number;
}

export interface ProcessRow {
  pid: number;
  ppid: number;
  tty: string;
}

/** 一個要結束的程序與它監聽的 port（由小到大、不重複）。 */
export interface SweepTarget {
  pid: number;
  command: string;
  ports: number[];
}

export interface PortSweepScan {
  targets: SweepTarget[];
}

export interface PortSweepResult {
  ended: SweepTarget[];
  failed: SweepTarget[];
}

/** 每個程序一組 p（pid）、c（完整指令名，+c 0）、u（uid），之後每個監聽的連線一個 n（位址）。 */
export const LSOF_ARGS = ["+c", "0", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcun"] as const;
export const PS_ARGS = ["-axo", "pid=,ppid=,tty="] as const;

const CONTROL = /[\u0000-\u001f\u007f]/g;
const PORT_AT_END = /:(\d{1,5})$/;
const TERMINAL_TTY = /^(tty\S*|pts\/\d+)$/;
const COMMAND_MAX = 80;

const toPort = (name: string): number | null => {
  const match = PORT_AT_END.exec(name);
  if (match === null) return null;
  const port = Number(match[1]);
  return port >= 1 && port <= 65535 ? port : null;
};

export const parseLsofListeners = (output: string): ListeningSocket[] => {
  const sockets: ListeningSocket[] = [];
  let current: { pid: number; command: string; uid: number } | null = null;
  for (const line of output.split("\n")) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      const pid = Number(value);
      current = Number.isInteger(pid) && pid > 0 ? { pid, command: "", uid: -1 } : null;
    } else if (current === null) {
      continue;
    } else if (tag === "c") {
      current.command = value.replace(CONTROL, "").slice(0, COMMAND_MAX);
    } else if (tag === "u") {
      const uid = Number(value);
      current.uid = Number.isInteger(uid) ? uid : -1;
    } else if (tag === "n") {
      const port = toPort(value);
      if (port !== null && current.uid >= 0) sockets.push({ pid: current.pid, command: current.command, uid: current.uid, port });
    }
  }
  return sockets;
};

export const parseProcessTable = (output: string): ProcessRow[] => {
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (match !== null) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), tty: match[3] ?? "" });
  }
  return rows;
};

/** macOS 沒有終端機的程序是 ??，登入視窗的是 console；只有 ttysNNN 這類才是終端機。 */
export const hasTerminal = (tty: string): boolean => TERMINAL_TTY.test(tty);

/** 自己、所有上層（啟動自己的 shell、pnpm dev…）與所有下層（Electron 的子程序）。 */
export const protectedPids = (rows: readonly ProcessRow[], selfPid: number): Set<number> => {
  const parentOf = new Map(rows.map((row) => [row.pid, row.ppid]));
  const children = new Map<number, number[]>();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);

  const result = new Set<number>([selfPid]);
  for (let pid = parentOf.get(selfPid); pid !== undefined && pid > 0 && !result.has(pid); pid = parentOf.get(pid)) result.add(pid);
  const queue = [selfPid];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of children.get(next) ?? []) {
      if (!result.has(child)) {
        result.add(child);
        queue.push(child);
      }
    }
  }
  return result;
};

export const selectSweepTargets = (input: {
  sockets: readonly ListeningSocket[];
  processes: readonly ProcessRow[];
  uid: number;
  selfPid: number;
}): SweepTarget[] => {
  const ttyOf = new Map(input.processes.map((row) => [row.pid, row.tty]));
  const skip = protectedPids(input.processes, input.selfPid);
  const byPid = new Map<number, SweepTarget>();
  for (const socket of input.sockets) {
    if (socket.uid !== input.uid || socket.pid <= 1 || skip.has(socket.pid)) continue;
    if (!hasTerminal(ttyOf.get(socket.pid) ?? "")) continue;
    const target = byPid.get(socket.pid) ?? { pid: socket.pid, command: socket.command, ports: [] };
    if (!target.ports.includes(socket.port)) target.ports.push(socket.port);
    byPid.set(socket.pid, target);
  }
  return [...byPid.values()]
    .map((target) => ({ ...target, ports: [...target.ports].sort((a, b) => a - b) }))
    .sort((a, b) => (a.ports[0] ?? 0) - (b.ports[0] ?? 0) || a.pid - b.pid);
};
