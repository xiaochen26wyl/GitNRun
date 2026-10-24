/**
 * iOS 模擬器視窗：從服務指令取出綁定的模擬器 UDID，並組出「File → Open Simulator」的 AppleScript，純函式。
 *
 * Simulator.app 已在執行時會忽略 `open -a Simulator --args -CurrentDeviceUDID`，新開機的裝置因此沒有視窗；
 * 關掉再重開會連帶關掉原本那台，所以改成點選單開視窗，不影響已開著的裝置。
 */

const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const UDID_IN_TEXT = /\b[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\b/i;

/** 取出指令裡 `-d <UDID>`、`--device-id <UDID>` 或 `simctl boot <UDID>` 綁定的模擬器；沒有指定回傳 null。 */
export const iosUdidOfCommand = (command: readonly string[]): string | null => {
  for (const [index, part] of command.entries()) {
    const next = command[index + 1];
    if ((part === "-d" || part === "--device-id") && next !== undefined && UDID.test(next)) return next;
  }
  const joined = command.join(" ");
  const boot = /simctl boot ([0-9A-F-]{36})\b/i.exec(joined);
  if (boot?.[1] !== undefined && UDID.test(boot[1])) return boot[1];
  const flag = new RegExp(`(?:-d|--device-id)\\s+(${UDID_IN_TEXT.source})`, "i").exec(joined);
  return flag?.[1] ?? null;
};

/** 從 `simctl list devices -j` 的輸出用 UDID 找裝置名稱；找不到或格式不對回傳 null。 */
export const deviceNameOf = (listJson: string, udid: string): string | null => {
  try {
    const parsed = JSON.parse(listJson) as { devices?: Record<string, Array<{ udid?: unknown; name?: unknown }>> };
    for (const devices of Object.values(parsed.devices ?? {})) {
      const found = devices.find((device) => typeof device.udid === "string" && device.udid.toUpperCase() === udid.toUpperCase());
      if (typeof found?.name === "string") return found.name;
    }
  } catch {
    return null;
  }
  return null;
};

/**
 * 開啟指定裝置視窗的 AppleScript（裝置名稱用參數傳入，不拼進腳本）。
 * 視窗標題是「<裝置名稱> – iOS 版本」，已有該視窗就不再點選單，避免搶走焦點。
 */
export const OPEN_SIMULATOR_WINDOW_SCRIPT = [
  "on run argv",
  "  set deviceName to item 1 of argv",
  '  tell application "System Events" to tell process "Simulator"',
  "    repeat with windowName in (name of every window)",
  '      if (windowName as text) starts with (deviceName & " – ") then return "exists"',
  "    end repeat",
  '    click menu item deviceName of (menu 1 of menu item "Open Simulator" of (menu 1 of menu bar item "File" of menu bar 1))',
  "  end tell",
  '  return "opened"',
  "end run"
].join("\n");

/** osascript 因沒有「輔助使用」授權而失敗的訊息特徵。 */
export const ACCESSIBILITY_DENIED = /-1719|-25211|不允許輔助取用|assistive access/i;

/** 從 `simctl list devices booted -j` 的輸出取出已開機的 UDID（大寫）；格式不對回傳空集合。 */
export const bootedUdids = (listJson: string): Set<string> => {
  const booted = new Set<string>();
  try {
    const parsed = JSON.parse(listJson) as { devices?: Record<string, Array<{ udid?: unknown; state?: unknown }>> };
    for (const devices of Object.values(parsed.devices ?? {})) {
      for (const device of devices) {
        if (device.state === "Booted" && typeof device.udid === "string") booted.add(device.udid.toUpperCase());
      }
    }
  } catch {
    return new Set();
  }
  return booted;
};

const FLUTTER_RUN = /(?:flutter_tools\.snapshot|\bflutter)\s+run\b/;

/** `ps -axo command=` 的輸出裡，有沒有 `flutter run` 程序綁定這個 UDID（命令列不含專案路徑，只能靠 UDID 認）。 */
export const flutterRunsOnDevice = (psOutput: string, udid: string): boolean => {
  const target = udid.toUpperCase();
  return psOutput.split("\n").some((line) => FLUTTER_RUN.test(line) && line.toUpperCase().includes(target));
};

/** iOS 服務是否還在執行：模擬器已開機，且有 flutter run 綁著它；只有模擬器開著不算。 */
export const iosServiceAlive = (input: { simctlJson: string; psOutput: string; udid: string }): boolean =>
  bootedUdids(input.simctlJson).has(input.udid.toUpperCase()) && flutterRunsOnDevice(input.psOutput, input.udid);
