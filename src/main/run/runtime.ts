import { readdirSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { DEFAULT_DOCUMENT_OPENER } from "@shared/documents";
import type { MobilePlatform } from "@shared/run";
import type { Db } from "@main/db/database";
import { findReadme, openPath } from "@main/documents/runtime";
import type { Logger } from "@main/logger";
import { detectAvailability, run as execForResult } from "@main/launcher/runtime";
import { buildItermCloseArgs, buildItermTabsArgs } from "@main/launcher/osascript";
import { native } from "@main/native/bridge";
import { detectFramework, type FrameworkFs } from "@main/run/framework";
import { createRunHandlers, type ConfirmCommandsRequest, type ConfirmReinstallRequest, type RunHandlers } from "@main/run/handlers";
import { detectInstaller } from "@main/run/installer";
import { loadManifest } from "@main/run/manifest";
import { fsPasscodeSource } from "@main/run/passcode-source";
import { createSystemPortSweep } from "@main/run/port-sweep";
import { allocatePorts, probePort, writePortsFile } from "@main/run/ports";
import type { Vault } from "@main/vault/vault";

/** 專案啟動：把外殼的對話框、瀏覽器、iTerm2 組進處理邏輯。 */

const OSASCRIPT = "/usr/bin/osascript";
const SHELL = "/bin/zsh";
const PERSONAL_PROJECTS_ROOT = "/Users/zorawl/Documents/GitHub";
/** 只會從主程序算出來的網址開瀏覽器；這裡再擋一次，避免任何呼叫端傳進其他網址。 */
const LOCAL_URL = /^http:\/\/localhost:[1-9][0-9]{0,4}$/;
const STOP_PORTS = /^kill -TERM \$\(lsof -ti tcp:[0-9]{1,5}\)(?: 2>\/dev\/null \|\| true; kill -TERM \$\(lsof -ti tcp:[0-9]{1,5}\))* 2>\/dev\/null \|\| true$/;

const confirmCommands = async (request: ConfirmCommandsRequest): Promise<boolean> => {
  native().bounceDock();
  const listing = request.lines.map((line) => `${line.service}：${line.command}`).join("\n");
  const response = await native().confirm({
    kind: "warning",
    title: "GitNRun",
    message: request.changed ? `「${request.label}」的啟動指令有變動，要執行嗎？` : `第一次執行「${request.label}」的啟動指令，要執行嗎？`,
    detail: `GitNRun 會控制 iTerm2 開啟分頁，並在指定資料夾執行下列指令。\n\n資料夾：${request.folder}\n\n將執行（{port} 等佔位會換成實際的 port）：\n${listing}\n\n指令會從專案設定或 package.json scripts 讀出；第一次執行或內容變更後都需要你確認。確認後，只要內容沒有再變動就不會再問。`,
    buttons: ["拒絕", "允許"],
    defaultId: 0,
    cancelId: 0
  });
  return response === 1;
};

const confirmReinstall = async (request: ConfirmReinstallRequest): Promise<boolean> => {
  native().bounceDock();
  const listing = request.items.map((item) => `${item.dir}：${item.command}`).join("\n");
  const response = await native().confirm({
    kind: "warning",
    title: "GitNRun",
    message: `要刪除「${request.label}」的 node_modules 並重裝依賴嗎？`,
    detail: `GitNRun 會控制 iTerm2 開啟分頁，在下列資料夾刪除 node_modules 後重新安裝依賴。\n\n專案：${request.folder}\n\n將執行（資料夾：指令）：\n${listing}\n\nlock 檔會保留。安裝時會執行 package.json 裡的安裝相關腳本（例如 postinstall）。每次重裝都會詢問。`,
    buttons: ["取消", "刪除並重裝"],
    defaultId: 0,
    cancelId: 0
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

const frameworkFs: FrameworkFs = {
  readText: (path) => readFile(path, "utf8").catch(() => null),
  listDirs: async (path) => {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name);
    } catch {
      return [];
    }
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

/**
 * 結束手機服務時關模擬器用的固定指令；不含任何外部輸入。
 * 啟動指令是用裝置名稱比對，不知道實際挑中哪一台，所以關掉該平台所有開著的模擬器。
 * 沒有開著的模擬器算成功；找不到 xcrun／adb 以非 0 結束並在 stderr 說明。
 */
const IOS_SHUTDOWN = [
  'command -v xcrun >/dev/null 2>&1 || { echo "找不到 xcrun（請先安裝 Xcode）" >&2; exit 127; }',
  'xcrun simctl list devices booted 2>/dev/null | grep -q "(Booted)" || exit 0',
  "xcrun simctl shutdown booted"
].join("; ");
const ANDROID_SHUTDOWN = [
  'adb_bin="$(command -v adb || true)"',
  '[ -n "$adb_bin" ] || adb_bin="$HOME/Library/Android/sdk/platform-tools/adb"',
  '[ -x "$adb_bin" ] || { echo "找不到 adb（請先安裝 Android SDK platform-tools）" >&2; exit 127; }',
  'for serial in $("$adb_bin" devices | awk \'/^emulator-[0-9]+[[:space:]]+device/ {print $1}\'); do "$adb_bin" -s "$serial" emu kill || exit 1; done'
].join("; ");

/** 平台對應的關模擬器指令；只有這兩支，其他值不存在。 */
export const simulatorShutdownCommand = (platform: MobilePlatform): string => {
  switch (platform) {
    case "ios":
      return IOS_SHUTDOWN;
    case "android":
      return ANDROID_SHUTDOWN;
  }
};

const closeSimulator = (platform: MobilePlatform): Promise<{ code: number; stderr: string }> =>
  execForResult(SHELL, ["-lc", simulatorShutdownCommand(platform)]);

export const createRunRuntime = (deps: { db: Db; logger: Logger; vault: Vault; copySecret: (secret: string) => Promise<void> }): RunHandlers =>
  createRunHandlers({
    db: deps.db,
    logger: deps.logger,
    vault: deps.vault,
    copySecret: deps.copySecret,
    passcodeSource: fsPasscodeSource,
    loadManifest: (folder) => loadManifest(folder),
    probe: probePort,
    allocatePorts,
    writePortsFile,
    discoverFolders,
    itermAvailable: () => detectAvailability().iterm,
    inspect,
    launchTabs: (tabs) => execForResult(OSASCRIPT, buildItermTabsArgs(tabs)),
    stopPorts,
    closeSimulator,
    closeTabs: (sessionNames) => execForResult(OSASCRIPT, buildItermCloseArgs(sessionNames)),
    confirmCommands,
    confirmReinstall,
    detectInstaller: (dir, inherited) => detectInstaller(dir, inherited),
    portSweep: createSystemPortSweep(),
    openUrl: async (url) => {
      if (!LOCAL_URL.test(url)) {
        throw new Error("不允許開啟非本機網址");
      }
      await native().openExternal(url);
    },
    detectFramework: (folder, spec) => detectFramework(folder, spec, frameworkFs),
    findReadme,
    openDocument: (path) => openPath(path, DEFAULT_DOCUMENT_OPENER, "file"),
    now: Date.now
  });
