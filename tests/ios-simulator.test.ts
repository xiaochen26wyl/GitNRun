import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deviceNameOf, iosUdidOfCommand, OPEN_SIMULATOR_WINDOW_SCRIPT } from "@shared/ios-simulator";
import { ensureSimulatorWindow, type ExecResult, type SimulatorExec } from "@main/run/simulator-window";

const DEV = "498D038D-9A95-4CB5-967C-B846B0E93DE8";
const DEV2 = "A6EFE51B-D80F-401A-86E3-4EFEC089F8F0";
const LIST = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
      { udid: DEV, name: "iPhone 17 dev" },
      { udid: DEV2, name: "iPhone 17 dev2" }
    ]
  }
});

describe("iosUdidOfCommand", () => {
  it("取出 -d 後面的 UDID", () => {
    assert.equal(iosUdidOfCommand(["flutter", "run", "-d", DEV2]), DEV2);
    assert.equal(iosUdidOfCommand(["npm", "run", "mobile:run", "--", "-d", DEV]), DEV);
  });
  it("取出 simctl boot 與腳本字串裡的 UDID", () => {
    assert.equal(iosUdidOfCommand(["zsh", "-lc", `xcrun simctl boot ${DEV} >/dev/null 2>&1 || true; exec flutter run -d ${DEV}`]), DEV);
    assert.equal(iosUdidOfCommand(["zsh", "-lc", `exec flutter run -d ${DEV2}`]), DEV2);
  });
  it("用名稱選裝置或格式不對時回傳 null", () => {
    assert.equal(iosUdidOfCommand(["flutter", "run", "-d", "iPhone"]), null);
    assert.equal(iosUdidOfCommand(["flutter", "run", "-d", "1234"]), null);
  });
});

describe("deviceNameOf", () => {
  it("用 UDID 找名稱，找不到或壞掉的輸出回傳 null", () => {
    assert.equal(deviceNameOf(LIST, DEV2), "iPhone 17 dev2");
    assert.equal(deviceNameOf(LIST, "00000000-0000-0000-0000-000000000000"), null);
    assert.equal(deviceNameOf("not json", DEV), null);
  });
});

const fakeExec = (handler: (file: string, args: string[]) => Partial<ExecResult>): { exec: SimulatorExec; calls: string[][] } => {
  const calls: string[][] = [];
  return {
    calls,
    exec: async (file, args) => {
      calls.push([file, ...args]);
      return { code: 0, stdout: "", stderr: "", ...handler(file, args) };
    }
  };
};

describe("ensureSimulatorWindow", () => {
  const noWait = async (): Promise<void> => undefined;

  it("開機後用選單開出該裝置的視窗，裝置名稱以參數傳入", async () => {
    const { exec, calls } = fakeExec((file, args) => (args[1] === "list" ? { stdout: LIST } : file.endsWith("osascript") ? { stdout: "opened\n" } : {}));
    const result = await ensureSimulatorWindow(DEV2, exec, noWait);
    assert.equal(result.ok, true);
    const script = calls.find((call) => call[0]?.endsWith("osascript"));
    assert.deepEqual(script, ["/usr/bin/osascript", "-e", OPEN_SIMULATOR_WINDOW_SCRIPT, "iPhone 17 dev2"]);
    assert.ok(!calls.some((call) => call.join(" ").includes("quit")), "不可關閉 Simulator");
  });

  it("沒有輔助使用授權時回報該說明並停止重試", async () => {
    const { exec, calls } = fakeExec((file, args) => {
      if (args[1] === "list") return { stdout: LIST };
      return file.endsWith("osascript") ? { code: 1, stderr: "execution error: osascript不允許輔助取用。 (-1719)" } : {};
    });
    const result = await ensureSimulatorWindow(DEV, exec, noWait);
    assert.equal(result.ok, false);
    assert.match(result.message, /輔助使用/);
    assert.equal(calls.filter((call) => call[0]?.endsWith("osascript")).length, 1);
  });

  it("選單還沒就緒時重試，之後成功", async () => {
    let tries = 0;
    const { exec } = fakeExec((file, args) => {
      if (args[1] === "list") return { stdout: LIST };
      if (!file.endsWith("osascript")) return {};
      tries += 1;
      return tries < 3 ? { code: 1, stderr: "menu not ready" } : { stdout: "exists\n" };
    });
    const result = await ensureSimulatorWindow(DEV, exec, noWait);
    assert.equal(result.ok, true);
    assert.equal(tries, 3);
  });

  it("找不到裝置、開機失敗或 UDID 不合法時不點選單", async () => {
    const missing = fakeExec(() => ({ stdout: JSON.stringify({ devices: {} }) }));
    assert.equal((await ensureSimulatorWindow(DEV, missing.exec, noWait)).ok, false);
    const bootFail = fakeExec((_file, args) => (args[1] === "list" ? { stdout: LIST } : args[1] === "bootstatus" ? { code: 1, stderr: "boom" } : {}));
    assert.equal((await ensureSimulatorWindow(DEV, bootFail.exec, noWait)).ok, false);
    assert.ok(!bootFail.calls.some((call) => call[0]?.endsWith("osascript")));
    assert.equal((await ensureSimulatorWindow("bad", missing.exec, noWait)).ok, false);
  });
});
