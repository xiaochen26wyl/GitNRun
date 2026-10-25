import { execFile } from "node:child_process";
import { ACCESSIBILITY_DENIED, deviceNameOf, OPEN_SIMULATOR_WINDOW_SCRIPT, runtimeLabelOf } from "@shared/ios-simulator";
import { isIosDeviceId } from "@main/run/manifest";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type SimulatorExec = (file: string, args: string[]) => Promise<ExecResult>;

export interface SimulatorWindowResult {
  ok: boolean;
  message: string;
}

const OPEN_WINDOW_ATTEMPTS = 8;
const OPEN_WINDOW_WAIT_MS = 1000;

const execFileResult: SimulatorExec = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolve({ code, stdout, stderr: stderr || (error?.message ?? "") });
    });
  });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 啟動前讓指定 iOS 模擬器開機並顯示自己的視窗。
 * 只開機、補視窗，不關 Simulator.app，所以其他已開著的模擬器與其中的 app 不受影響。
 * 失敗只回報訊息，不擋住後面的 flutter run。
 */
export const ensureSimulatorWindow = async (
  udid: string,
  exec: SimulatorExec = execFileResult,
  wait: (ms: number) => Promise<void> = sleep
): Promise<SimulatorWindowResult> => {
  if (!isIosDeviceId(udid)) return { ok: false, message: "不合法的 iOS 模擬器 UDID" };

  const list = await exec("/usr/bin/xcrun", ["simctl", "list", "devices", "-j"]);
  const name = list.code === 0 ? deviceNameOf(list.stdout, udid) : null;
  const runtimeLabel = (list.code === 0 ? runtimeLabelOf(list.stdout, udid) : null) ?? "";
  if (name === null) return { ok: false, message: `找不到 UDID 為 ${udid} 的模擬器` };

  // 已開機時 boot 會失敗，可以忽略；bootstatus -b 等到開機完成。
  await exec("/usr/bin/xcrun", ["simctl", "boot", udid]);
  const booted = await exec("/usr/bin/xcrun", ["simctl", "bootstatus", udid, "-b"]);
  if (booted.code !== 0) return { ok: false, message: `模擬器 ${name} 開機失敗：${booted.stderr.trim().slice(0, 200)}` };

  // 沒在執行時用 -g 開在背景，之後由選單補上該裝置視窗。
  await exec("/usr/bin/open", ["-g", "-a", "Simulator"]);

  let lastError = "";
  for (let attempt = 0; attempt < OPEN_WINDOW_ATTEMPTS; attempt += 1) {
    const result = await exec("/usr/bin/osascript", ["-e", OPEN_SIMULATOR_WINDOW_SCRIPT, name, runtimeLabel]);
    if (result.code === 0) return { ok: true, message: `${name} 的視窗${result.stdout.trim() === "exists" ? "已存在" : "已開啟"}` };
    lastError = result.stderr.trim();
    if (ACCESSIBILITY_DENIED.test(lastError)) {
      return { ok: false, message: `沒有「輔助使用」授權，無法自動開啟 ${name} 的視窗；請到「系統設定 → 隱私權與安全性 → 輔助使用」開啟 GitNRun，或手動用 File → Open Simulator 開啟` };
    }
    // Simulator 剛啟動時選單還沒就緒，稍等再試。
    await wait(OPEN_WINDOW_WAIT_MS);
  }
  return { ok: false, message: `無法開啟 ${name} 的視窗：${lastError.slice(0, 200)}` };
};
