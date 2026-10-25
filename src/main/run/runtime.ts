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
import { createRunHandlers, type ConfirmCommandsRequest, type ConfirmReinstallRequest, type ConfirmReleaseRequest, type ConfirmStaleRequest, type RunHandlers } from "@main/run/handlers";
import { detectInstaller } from "@main/run/installer";
import { isAndroidDeviceId, isIosDeviceId, loadManifest } from "@main/run/manifest";
import { fsPasscodeSource } from "@main/run/passcode-source";
import { createSystemPortSweep } from "@main/run/port-sweep";
import { createSystemPortOwners } from "@main/run/port-owners";
import { ensureSimulatorWindow } from "@main/run/simulator-window";
import { isIosServiceAlive } from "@main/run/ios-liveness";
import { createSystemStaleProcesses } from "@main/run/stale-process";
import { describeStale } from "@shared/stale-process";
import { allocatePorts, probePort, readPortsFile, writePortsFile } from "@main/run/ports";
import type { Vault } from "@main/vault/vault";

/** 專案啟動：把外殼的對話框、瀏覽器、iTerm2 組進處理邏輯。 */

const OSASCRIPT = "/usr/bin/osascript";
const SHELL = "/bin/zsh";
const PERSONAL_PROJECTS_ROOT = "/Users/zorawl/Documents/GitHub";
/** 只會從主程序算出來的網址開瀏覽器；這裡再擋一次，避免任何呼叫端傳進其他網址。 */
const LOCAL_URL = /^http:\/\/localhost:[1-9][0-9]{0,4}$/;

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

const confirmStale = async (request: ConfirmStaleRequest): Promise<boolean> => {
  native().bounceDock();
  const response = await native().confirm({
    kind: "warning",
    title: "GitNRun",
    message: `「${request.label}」還有 ${request.processes.length} 個舊程序在背景執行，要先結束再啟動嗎？`,
    detail: `桌面 app 通常只允許同時開一份；舊的還在時，新啟動的會被擋掉並立刻退出。\n\n專案：${request.folder}\n\n將結束：\n${describeStale(request.processes, request.folder)}\n\n會先送出結束訊號，3 秒後仍未退出的才強制結束。`,
    buttons: ["取消", "結束後啟動"],
    defaultId: 0,
    cancelId: 0
  });
  return response === 1;
};

const confirmRelease = async (request: ConfirmReleaseRequest): Promise<boolean> => {
  native().bounceDock();
  const single = request.items.length === 1 ? request.items[0] : undefined;
  const portLines = request.items.filter((item) => item.ports.length > 0).map((item) => `${item.service}：port ${item.ports.join("、")}`);
  const portLine = portLines.length > 0 ? `將結束占用 port 的程序：${single !== undefined ? single.ports.join("、") : `\n${portLines.join("\n")}`}\n\n` : "";
  const staleLine = request.processes.length > 0 ? `將結束資料夾裡的殘留程序：\n${describeStale(request.processes, request.folder)}\n\n` : "";
  const response = await native().confirm({
    kind: "warning",
    title: "GitNRun",
    message: single !== undefined ? `要釋放「${request.label}」的 ${single.service} 嗎？` : `要釋放「${request.label}」的 ${request.items.length} 個服務嗎？`,
    detail: `${portLine}${staleLine}只會處理${single !== undefined ? "這個服務" : `這 ${request.items.length} 個服務`}，同專案的其他服務不受影響。占用 port 的程序只送出結束訊號；殘留程序 3 秒後仍未退出才強制結束。`,
    buttons: ["取消", "釋放"],
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

/**
 * 結束手機服務時關模擬器用的固定指令；裝置識別碼先驗格式，不含其他外部輸入。
 * 一律只關服務綁定的那一台（iOS 用 UDID、Android 用 AVD 名稱或 emulator 序號），不關其他專案開著的模擬器。
 * 那一台沒有開著算成功；找不到 xcrun／adb 以非 0 結束並在 stderr 說明。
 */
const ADB_LOOKUP = [
  'adb_bin="$(command -v adb || true)"',
  '[ -n "$adb_bin" ] || adb_bin="$HOME/Library/Android/sdk/platform-tools/adb"',
  '[ -x "$adb_bin" ] || { echo "找不到 adb（請先安裝 Android SDK platform-tools）" >&2; exit 127; }'
];

export const simulatorShutdownCommand = (platform: MobilePlatform, deviceId: string): string => {
  switch (platform) {
    case "ios":
      if (!isIosDeviceId(deviceId)) throw new Error("不合法的 iOS 模擬器 UDID");
      return [
        'command -v xcrun >/dev/null 2>&1 || { echo "找不到 xcrun（請先安裝 Xcode）" >&2; exit 127; }',
        `xcrun simctl list devices booted 2>/dev/null | grep -q "${deviceId}" || exit 0`,
        `xcrun simctl shutdown ${deviceId}`
      ].join("; ");
    case "android":
      if (!isAndroidDeviceId(deviceId)) throw new Error("不合法的 Android 模擬器識別碼");
      return [
        ...ADB_LOOKUP,
        `target='${deviceId}'`,
        'for serial in $("$adb_bin" devices | awk \'/^emulator-[0-9]+[[:space:]]+device/ {print $1}\'); do if [ "$serial" = "$target" ] || [ "$("$adb_bin" -s "$serial" emu avd name 2>/dev/null | head -n 1 | tr -d "\\r")" = "$target" ]; then "$adb_bin" -s "$serial" emu kill || exit 1; fi; done'
      ].join("; ");
  }
};

const closeSimulator = (platform: MobilePlatform, deviceId: string): Promise<{ code: number; stderr: string }> =>
  execForResult(SHELL, ["-lc", simulatorShutdownCommand(platform, deviceId)]);

export const createRunRuntime = (deps: { db: Db; logger: Logger; vault: Vault; copySecret: (secret: string) => Promise<void> }): RunHandlers => {
  const portOwners = createSystemPortOwners();
  return createRunHandlers({
    db: deps.db,
    logger: deps.logger,
    vault: deps.vault,
    copySecret: deps.copySecret,
    passcodeSource: fsPasscodeSource,
    loadManifest: (folder) => loadManifest(folder),
    probe: probePort,
    allocatePorts,
    writePortsFile,
    readPortsFile,
    discoverFolders,
    itermAvailable: () => detectAvailability().iterm,
    inspect,
    launchTabs: (tabs) => execForResult(OSASCRIPT, buildItermTabsArgs(tabs)),
    stopPorts: (ports, folder) => portOwners.stop(folder, ports),
    portOwners: (folder, ports) => portOwners.resolve(folder, ports),
    closeSimulator,
    prepareSimulator: (udid) => ensureSimulatorWindow(udid),
    iosServiceAlive: isIosServiceAlive,
    closeTabs: (sessionNames) => execForResult(OSASCRIPT, buildItermCloseArgs(sessionNames)),
    confirmCommands,
    confirmReinstall,
    detectInstaller: (dir, inherited) => detectInstaller(dir, inherited),
    portSweep: createSystemPortSweep(),
    staleProcesses: createSystemStaleProcesses(),
    confirmStale,
    confirmRelease,
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
};
