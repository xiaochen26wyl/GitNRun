/**
 * 殘留程序：專案資料夾裡留在背景的開發程序（例如關掉視窗但還活著的 Electron），純函式。
 *
 * 只認「命令列同時含專案資料夾與其下的 node_modules」的本人程序，不碰編輯器、終端機與沒有路徑的程式；
 * GitNRun 自己和它的上下層程序一律排除。
 */

import { protectedPids } from "@shared/port-sweep";

export interface StaleProcess {
  pid: number;
  ppid: number;
  /** ps 的 etime（[[dd-]hh:]mm:ss）；不受系統語言影響。 */
  elapsed: string;
  command: string;
}

export interface StaleProcessRow extends StaleProcess {
  uid: number;
  tty: string;
}

export const STALE_PS_ARGS = ["-axo", "pid=,ppid=,uid=,tty=,etime=,command="] as const;

const CONTROL = /[\u0000-\u001f\u007f]/g;
const COMMAND_MAX = 200;
const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+((?:\d+-)?(?:\d+:)?\d+:\d{2})\s+(.+)$/;
const PATH_START = new Set([" ", "=", ":", "\"", "'"]);
const NODE_RUNNERS = new Set(["pnpm", "npm", "yarn", "bun", "npx", "node", "electron-vite", "electron", "vite"]);

export const parseStaleRows = (output: string): StaleProcessRow[] => {
  const rows: StaleProcessRow[] = [];
  for (const line of output.split("\n")) {
    const match = ROW.exec(line);
    if (match === null) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      uid: Number(match[3]),
      tty: match[4] ?? "",
      elapsed: match[5] ?? "",
      command: (match[6] ?? "").replace(CONTROL, "").slice(0, COMMAND_MAX)
    });
  }
  return rows;
};

/** 命令列含「資料夾/…/node_modules/」，且資料夾前面是路徑起點，避免 /a/app 誤中 /b/a/app。 */
export const commandInProject = (command: string, folder: string): boolean => {
  const base = `${folder.replace(/\/+$/, "")}/`;
  for (let from = command.indexOf(base); from !== -1; from = command.indexOf(base, from + 1)) {
    const before = from === 0 ? "" : (command[from - 1] ?? "");
    if ((from === 0 || PATH_START.has(before)) && command.slice(from + base.length).includes("node_modules/")) return true;
  }
  return false;
};

export const selectStaleProcesses = (input: {
  rows: readonly StaleProcessRow[];
  folder: string;
  uid: number;
  selfPid: number;
}): StaleProcess[] => {
  const skip = protectedPids(input.rows, input.selfPid);
  return input.rows
    .filter((row) => row.uid === input.uid && row.pid > 1 && !skip.has(row.pid) && commandInProject(row.command, input.folder))
    .map(({ pid, ppid, elapsed, command }) => ({ pid, ppid, elapsed, command }))
    .sort((a, b) => a.pid - b.pid);
};

/** 確認框與訊息用：最多列幾行，其餘寫「另有 N 個」。 */
export const describeStale = (list: readonly StaleProcess[], folder: string, limit = 6): string => {
  const shorten = (command: string): string => command.split(folder).join(".").slice(0, 110);
  const lines = list.slice(0, limit).map((item) => `PID ${item.pid}（已執行 ${item.elapsed}）${shorten(item.command)}`);
  return list.length > limit ? [...lines, `另有 ${list.length - limit} 個程序`].join("\n") : lines.join("\n");
};

/** 啟動後立即退出的偵測只對 Node 系指令有意義（它們的程序路徑會含 node_modules）。 */
export const isNodeStyleCommand = (command: readonly string[]): boolean => {
  const first = (command[0] ?? "").split("/").pop() ?? "";
  return NODE_RUNNERS.has(first);
};
