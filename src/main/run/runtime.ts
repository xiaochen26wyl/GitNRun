import { stat } from "node:fs/promises";
import { app, dialog, shell } from "electron";
import type { Db } from "@main/db/database";
import type { Logger } from "@main/logger";
import { detectAvailability, run as execForResult } from "@main/launcher/runtime";
import { buildItermTabsArgs } from "@main/launcher/osascript";
import { createRunHandlers, type ConfirmCommandsRequest, type RunHandlers } from "@main/run/handlers";
import { loadManifest } from "@main/run/manifest";
import { allocatePorts, probePort, writePortsFile } from "@main/run/ports";
import type { Vault } from "@main/vault/vault";

/** 專案啟動：把 Electron 的對話框、瀏覽器、iTerm2 組進處理邏輯。 */

const OSASCRIPT = "/usr/bin/osascript";
/** 只會從主程序算出來的網址開瀏覽器；這裡再擋一次，避免任何呼叫端傳進其他網址。 */
const LOCAL_URL = /^http:\/\/localhost:[1-9][0-9]{0,4}$/;

const confirmCommands = async (request: ConfirmCommandsRequest): Promise<boolean> => {
  app.dock?.bounce("critical");
  const listing = request.lines.map((line) => `${line.service}：${line.command}`).join("\n");
  const { response } = await dialog.showMessageBox({
    type: "warning",
    title: "GitNRun",
    message: request.changed ? `「${request.label}」的啟動指令有變動，要執行嗎？` : `第一次執行「${request.label}」的啟動指令，要執行嗎？`,
    detail: `資料夾：${request.folder}\n\n將在 iTerm2 執行（{port} 等佔位會換成實際的 port）：\n${listing}\n\n這些指令來自專案裡的 .gitnrun/run.json。確認後，只要檔案內容沒有再變動就不會再問。`,
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
    itermAvailable: () => detectAvailability().iterm,
    inspect,
    launchTabs: (tabs) => execForResult(OSASCRIPT, buildItermTabsArgs(tabs)),
    confirmCommands,
    openUrl: async (url) => {
      if (!LOCAL_URL.test(url)) {
        throw new Error("不允許開啟非本機網址");
      }
      await shell.openExternal(url);
    },
    now: Date.now
  });
