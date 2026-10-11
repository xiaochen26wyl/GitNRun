import { readdirSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { app, dialog, shell } from "electron";
import type { Db } from "@main/db/database";
import type { Logger } from "@main/logger";
import { detectAvailability, run as execForResult } from "@main/launcher/runtime";
import { buildItermTabsArgs, buildItermWriteTextArgs } from "@main/launcher/osascript";
import { createRunHandlers, type ConfirmCommandsRequest, type RunHandlers } from "@main/run/handlers";
import { loadManifest } from "@main/run/manifest";
import { allocatePorts, probePort, writePortsFile } from "@main/run/ports";
import type { Vault } from "@main/vault/vault";

/** 專案啟動：把 Electron 的對話框、瀏覽器、iTerm2 組進處理邏輯。 */

const OSASCRIPT = "/usr/bin/osascript";
const SHELL = "/bin/zsh";
const PERSONAL_PROJECTS_ROOT = "/Users/zorawl/Documents/GitHub";
/** 只會從主程序算出來的網址開瀏覽器；這裡再擋一次，避免任何呼叫端傳進其他網址。 */
const LOCAL_URL = /^http:\/\/localhost:[1-9][0-9]{0,4}$/;
const STOP_PORTS = /^kill -TERM \$\(lsof -ti tcp:[0-9]{1,5}\)(?: 2>\/dev\/null \|\| true; kill -TERM \$\(lsof -ti tcp:[0-9]{1,5}\))* 2>\/dev\/null \|\| true$/;

const confirmCommands = async (request: ConfirmCommandsRequest): Promise<boolean> => {
  app.dock?.bounce("critical");
  const listing = request.lines.map((line) => `${line.service}：${line.command}`).join("\n");
  const { response } = await dialog.showMessageBox({
    type: "warning",
    title: "devRun",
    message: request.changed ? `「${request.label}」的啟動指令有變動，要執行嗎？` : `第一次執行「${request.label}」的啟動指令，要執行嗎？`,
    detail: `GitNRun 會控制 iTerm2 開啟分頁，並在指定資料夾執行下列指令。\n\n資料夾：${request.folder}\n\n將執行（{port} 等佔位會換成實際的 port）：\n${listing}\n\n指令會從專案設定或 package.json scripts 讀出；第一次執行或內容變更後都需要你確認。確認後，只要內容沒有再變動就不會再問。`,
    buttons: ["拒絕", "允許"],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  return response === 1;
};

const inspect = async (path: string): Promise<"dir" | "file" | "missing"> => {
  const info = await stat(path).catch(() => null);
  return info === null ? "missing" : info.isDirectory() ? "dir" : "file";
};

const discoverFolders = (): Array<{ label: string; folder: string }> => {
  try {
    return readdirSync(PERSONAL_PROJECTS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => ({ label: entry.name, folder: `${PERSONAL_PROJECTS_ROOT}/${entry.name}` }))
      .filter((entry) => {
        try {
          return statSync(entry.folder).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
};

const stopPorts = (ports: number[]): Promise<{ code: number; stderr: string }> => {
  if (ports.length === 0) {
    return Promise.resolve({ code: 0, stderr: "" });
  }
  const command = ports.map((port) => `kill -TERM $(lsof -ti tcp:${port})`).join(" 2>/dev/null || true; ");
  const safeCommand = `${command} 2>/dev/null || true`;
  if (!STOP_PORTS.test(safeCommand)) {
    return Promise.resolve({ code: 1, stderr: "停止指令格式不正確" });
  }
  return execForResult(SHELL, ["-lc", safeCommand]);
};

export const createRunRuntime = (deps: { db: Db; logger: Logger; vault: Vault; copySecret: (secret: string) => void }): RunHandlers =>
  createRunHandlers({
    db: deps.db,
    logger: deps.logger,
    vault: deps.vault,
    copySecret: deps.copySecret,
    loadManifest: (folder) => loadManifest(folder),
    probe: probePort,
    allocatePorts,
    writePortsFile,
    discoverFolders,
    itermAvailable: () => detectAvailability().iterm,
    inspect,
    launchTabs: (tabs) => execForResult(OSASCRIPT, buildItermTabsArgs(tabs)),
    sendTextToTabs: (text, sessionNames) => execForResult(OSASCRIPT, buildItermWriteTextArgs(text, sessionNames)),
    stopPorts,
    confirmCommands,
    openUrl: async (url) => {
      if (!LOCAL_URL.test(url)) {
        throw new Error("不允許開啟非本機網址");
      }
      await shell.openExternal(url);
    },
    now: Date.now
  });
