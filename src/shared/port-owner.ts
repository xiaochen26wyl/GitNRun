import type { ListeningSocket } from "./port-sweep";

/**
 * 專案內釋放 port：判斷某個 port 的監聽者是不是這個專案自己的程序（純函式）。
 * 候選 port 可能來自舊的 .dev/ports.json 或固定 port，之後被別的專案占用，所以結束前一律先驗證歸屬；
 * 查不到資訊時視為不屬於（fail-closed）。
 */

export interface OwnerProcess {
  pid: number;
  ppid: number;
  command: string;
}

/** 監聽這個 port、但不屬於該專案的程序；pid 為 0 代表 lsof 看不到監聽者（例如別的使用者的程序）。 */
export interface ForeignListener {
  port: number;
  pid: number;
  command: string;
}

export interface PortOwnership {
  /** 屬於該專案的監聽程序（每個 port 一筆，pids 由小到大）。 */
  owned: Array<{ port: number; pids: number[] }>;
  foreign: ForeignListener[];
}

/** 取一批 pid 的工作目錄；-Fpn 每個程序輸出 p（pid）、f（fcwd）、n（路徑）。 */
export const lsofCwdArgs = (pids: readonly number[]): string[] => ["-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")];

const CONTROL = /[\u0000-\u001f\u007f]/g;

export const parseLsofCwds = (output: string): Map<number, string> => {
  const cwds = new Map<number, string>();
  let pid: number | null = null;
  for (const line of output.split("\n")) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      const next = Number(value);
      pid = Number.isInteger(next) && next > 0 ? next : null;
    } else if (tag === "n" && pid !== null && value.startsWith("/")) {
      cwds.set(pid, value.replace(CONTROL, ""));
      pid = null;
    }
  }
  return cwds;
};

const trimSlash = (path: string): string => path.replace(/\/+$/, "");

/** 路徑等於資料夾，或在資料夾底下；以路徑邊界比對，/a/app 不會誤中 /a/app2。 */
export const insideFolder = (path: string, folders: readonly string[]): boolean =>
  folders.some((folder) => {
    const base = trimSlash(folder);
    return base !== "" && (path === base || path.startsWith(`${base}/`));
  });

const PATH_START = new Set([" ", "=", ":", '"', "'", "("]);

/** 命令列裡出現「資料夾/…」，且資料夾前面是路徑起點。 */
export const commandMentionsFolder = (command: string, folders: readonly string[]): boolean =>
  folders.some((folder) => {
    const base = `${trimSlash(folder)}/`;
    if (base === "/") return false;
    for (let from = command.indexOf(base); from !== -1; from = command.indexOf(base, from + 1)) {
      if (from === 0 || PATH_START.has(command[from - 1] ?? "")) return true;
    }
    return false;
  });

/** 從 pid 往上追到 init；用在「監聽者本身看不出屬於誰，但它的上層（pnpm、shell）在專案資料夾裡」。 */
export const ancestorsOf = (pid: number, processes: readonly OwnerProcess[]): number[] => {
  const parentOf = new Map(processes.map((row) => [row.pid, row.ppid]));
  const chain: number[] = [];
  const seen = new Set<number>();
  for (let next: number | undefined = pid; next !== undefined && next > 1 && !seen.has(next); next = parentOf.get(next)) {
    chain.push(next);
    seen.add(next);
  }
  return chain;
};

export const selectPortOwnership = (input: {
  ports: readonly number[];
  sockets: readonly ListeningSocket[];
  processes: readonly OwnerProcess[];
  cwds: ReadonlyMap<number, string>;
  /** 專案資料夾，可同時給原路徑與真實路徑（符號連結）。 */
  folders: readonly string[];
}): PortOwnership => {
  const commandOf = new Map(input.processes.map((row) => [row.pid, row.command]));
  const belongs = (pid: number): boolean => {
    const cwd = input.cwds.get(pid);
    if (cwd !== undefined && insideFolder(cwd, input.folders)) return true;
    return commandMentionsFolder(commandOf.get(pid) ?? "", input.folders);
  };

  const owned: PortOwnership["owned"] = [];
  const foreign: ForeignListener[] = [];
  for (const port of [...new Set(input.ports)].sort((a, b) => a - b)) {
    const listeners = input.sockets.filter((socket) => socket.port === port && socket.pid > 1);
    if (listeners.length === 0) {
      foreign.push({ port, pid: 0, command: "" });
      continue;
    }
    const ownedPids = new Set<number>();
    for (const listener of listeners) {
      if (ancestorsOf(listener.pid, input.processes).some(belongs)) ownedPids.add(listener.pid);
      else if (belongs(listener.pid)) ownedPids.add(listener.pid);
      else if (!foreign.some((item) => item.port === port && item.pid === listener.pid)) foreign.push({ port, pid: listener.pid, command: listener.command });
    }
    if (ownedPids.size > 0) owned.push({ port, pids: [...ownedPids].sort((a, b) => a - b) });
  }
  return { owned, foreign };
};

/** 結果訊息用：「port 5175（node PID 1709）」。 */
export const describeForeign = (items: readonly ForeignListener[]): string =>
  items.map((item) => (item.pid === 0 ? `port ${item.port}（無法辨識占用者）` : `port ${item.port}（${item.command || "未知"} PID ${item.pid}）`)).join("、");
