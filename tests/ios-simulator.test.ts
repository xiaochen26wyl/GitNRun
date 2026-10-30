import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bootedUdids, flutterRunsOnDevice, iosServiceAlive, deviceNameOf, iosUdidOfCommand, selectFlutterRunsOnDevices, OPEN_SIMULATOR_WINDOW_SCRIPT, runtimeLabelOf, runtimeMenuLabel } from "@shared/ios-simulator";
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

describe("開窗選單與腳本", () => {
  it("runtime 名稱轉成選單上的版本文字（兩位與三位版本號）", () => {
    assert.equal(runtimeMenuLabel("com.apple.CoreSimulator.SimRuntime.iOS-26-5"), "iOS 26.5");
    assert.equal(runtimeMenuLabel("com.apple.CoreSimulator.SimRuntime.iOS-17-5"), "iOS 17.5");
    assert.equal(runtimeMenuLabel("com.apple.CoreSimulator.SimRuntime.iOS-26-0-1"), "iOS 26.0.1");
    assert.equal(runtimeMenuLabel("rt"), null);
  });
  it("同名裝置存在於不同版本時，取該 UDID 所屬的版本", () => {
    const list = JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [{ udid: "AAAAAAAA-0000-0000-0000-000000000000", name: "iPhone 15" }],
        "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [{ udid: DEV, name: "iPhone 15" }]
      }
    });
    assert.equal(runtimeLabelOf(list, DEV), "iOS 26.5");
    assert.equal(runtimeLabelOf(list, "00000000-0000-0000-0000-000000000000"), null);
    assert.equal(runtimeLabelOf("not json", DEV), null);
  });
  it("腳本走兩層選單（版本 → 裝置），並略過讀不到名稱的視窗", () => {
    assert.match(OPEN_SIMULATOR_WINDOW_SCRIPT, /menu item deviceName of \(menu 1 of menu item runtimeLabel of openMenu\)/);
    assert.match(OPEN_SIMULATOR_WINDOW_SCRIPT, /menu item deviceName of \(menu 1 of runtimeItem\)/);
    assert.match(OPEN_SIMULATOR_WINDOW_SCRIPT, /try\n\s+if \(\(contents of windowName\) as text\)/);
    assert.doesNotMatch(OPEN_SIMULATOR_WINDOW_SCRIPT, /repeat with windowName in \(name of every window\)/);
  });
});

describe("ensureSimulatorWindow", () => {
  const noWait = async (): Promise<void> => undefined;

  it("開機後用選單開出該裝置的視窗，裝置名稱以參數傳入", async () => {
    const { exec, calls } = fakeExec((file, args) => (args[1] === "list" ? { stdout: LIST } : file.endsWith("osascript") ? { stdout: "opened\n" } : {}));
    const result = await ensureSimulatorWindow(DEV2, exec, noWait);
    assert.equal(result.ok, true);
    const script = calls.find((call) => call[0]?.endsWith("osascript"));
    assert.deepEqual(script, ["/usr/bin/osascript", "-e", OPEN_SIMULATOR_WINDOW_SCRIPT, "iPhone 17 dev2", "iOS 26.5"]);
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

describe("iosServiceAlive", () => {
  const booted = (...udids: string[]): string =>
    JSON.stringify({ devices: { rt: udids.map((udid) => ({ udid, name: "x", state: "Booted" })).concat([{ udid: "OTHER", name: "y", state: "Shutdown" }]) } });
  const ps = (udid: string): string =>
    `-zsh\n/opt/flutter/bin/cache/dart-sdk/bin/dartvm --packages=/p.json /opt/flutter/bin/cache/flutter_tools.snapshot run -d ${udid} --dart-define=A=b\n`;

  it("只收 Booted 的裝置", () => {
    assert.deepEqual([...bootedUdids(booted(DEV))], [DEV]);
    assert.equal(bootedUdids("not json").size, 0);
  });
  it("模擬器已開機且有 flutter run 綁著 → 執行中", () => {
    assert.equal(iosServiceAlive({ simctlJson: booted(DEV2), psOutput: ps(DEV2), udid: DEV2 }), true);
  });
  it("只有模擬器開著、沒有 flutter run → 不算執行中", () => {
    assert.equal(iosServiceAlive({ simctlJson: booted(DEV2), psOutput: "-zsh\n", udid: DEV2 }), false);
  });
  it("flutter run 綁的是另一台，或該台沒開機 → 不算執行中", () => {
    assert.equal(flutterRunsOnDevice(ps(DEV), DEV2), false);
    assert.equal(iosServiceAlive({ simctlJson: booted(DEV), psOutput: ps(DEV2), udid: DEV2 }), false);
  });
});

describe("flutter run on a simulator", () => {
  const row = (pid: number, command: string, uid = 501, ppid = 1) => ({ pid, ppid, uid, tty: "ttys001", elapsed: "01:00", command });
  const rows = [
    row(10, `flutter run -d ${DEV}`),
    row(11, `/x/flutter_tools.snapshot run -d ${DEV.toLowerCase()}`),
    row(12, `flutter run -d ${DEV2}`),
    row(13, `flutter run -d ${DEV}`, 0),
    row(14, `vim notes ${DEV}`)
  ];

  it("picks only the user's own flutter run processes bound to the given device, case-insensitively", () => {
    const found = selectFlutterRunsOnDevices({ rows, udids: [DEV], uid: 501, selfPid: 999 });
    assert.deepEqual(found.map((item) => item.pid), [10, 11]);
    assert.deepEqual(selectFlutterRunsOnDevices({ rows, udids: [], uid: 501, selfPid: 999 }), []);
  });

  it("never picks GitNRun itself or its parents", () => {
    const withSelf = [row(20, `flutter run -d ${DEV}`, 501, 1), row(21, "gitnrun", 501, 20)];
    assert.deepEqual(selectFlutterRunsOnDevices({ rows: withSelf, udids: [DEV], uid: 501, selfPid: 21 }), []);
  });
});
