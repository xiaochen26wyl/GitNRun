import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
  isPasscodeFile,
  isPasscodeKey,
  normalizePasscodeBinding,
  passcodeProblem,
  validateManifest,
  type InstallManager,
  type MobilePlatform,
  type PasscodeBinding,
  type RunAction,
  type RunManifest,
  type RunServiceActionName
} from "@shared/run";
import { addProject } from "@main/db/projects-repo";
import { UserFacingError } from "@main/errors";
import type { ItermTab } from "@main/launcher/osascript";
import type { PortSweepResult } from "@shared/port-sweep";
import type { StaleProcess } from "@shared/stale-process";
import { createRunHandlers, type ConfirmCommandsRequest, type ConfirmReinstallRequest } from "@main/run/handlers";
import { FLUTTER_ANDROID_RUN_SCRIPT, FLUTTER_IOS_RUN_SCRIPT, iosRunScript, type LoadedManifest } from "@main/run/manifest";
import {
  fsPasscodeSource,
  interpretEnvText,
  isPasscodeCandidateKey,
  parseEnvText,
  type PasscodeSourceReader
} from "@main/run/passcode-source";
import { getPasscodeBinding, getRunAccount, isRunTrusted, setPasscodeBinding } from "@main/run/store";
import { setSetting } from "@main/db/settings-repo";
import { createVault } from "@main/vault/vault";
import { createTestDb } from "./helpers/db";
import { createFakeCipher } from "./helpers/fake-cipher";

const manifestOf = (): RunManifest => {
  const result = validateManifest({
    version: 1,
    services: [
      { name: "api", role: "backend", cwd: "api", command: ["pnpm", "dev"], port: true, env: { DEV_PORT: "{port}", FRONT: "{web.url}" } },
      { name: "web", role: "frontend", command: ["pnpm", "dev"], needs: ["api"], port: true, env: { PORT: "{port}", API: "{api.url}" } },
      { name: "panel", role: "desktop", command: ["pnpm", "dev:desktop"], needs: ["api"], port: true, env: { PORT: "{port}", API: "{api.url}" } }
    ]
  });
  assert.ok(result.ok);
  return result.manifest;
};

const multiFrontendManifestOf = (): RunManifest => {
  const result = validateManifest({
    version: 1,
    services: [
      { name: "api", role: "backend", command: ["pnpm", "dev:api"], port: true, env: { PORT: "{port}" } },
      { name: "fictionpurr", role: "frontend", command: ["pnpm", "dev:fiction"], needs: ["api"], port: true, env: { PORT: "{port}", API: "{api.url}" } },
      { name: "sparkpurr", role: "frontend", command: ["pnpm", "dev:spark"], needs: ["api"], port: true, env: { PORT: "{port}", API: "{api.url}" } }
    ]
  });
  assert.ok(result.ok);
  return result.manifest;
};

const fixedManifestOf = (): RunManifest => {
  const result = validateManifest({
    version: 1,
    services: [
      { name: "api", role: "backend", command: ["pnpm", "dev"], port: true, fixedPort: 5174, env: { PORT: "{port}" } },
      { name: "web", role: "frontend", command: ["pnpm", "dev"], port: true, needs: ["api"], env: { PORT: "{port}", API: "{api.url}" } }
    ]
  });
  assert.ok(result.ok);
  return result.manifest;
};

const mobileManifestOf = (): RunManifest => {
  const result = validateManifest({
    version: 1,
    services: [
      { name: "web", role: "frontend", command: ["pnpm", "dev"], port: true, env: { PORT: "{port}" } },
      { name: "mobile-anipurr-ios", role: "desktop", command: ["zsh", "-lc", FLUTTER_IOS_RUN_SCRIPT], port: false, env: {} },
      { name: "mobile-anipurr-android", role: "desktop", command: ["zsh", "-lc", FLUTTER_ANDROID_RUN_SCRIPT], port: false, env: {} }
    ]
  });
  assert.ok(result.ok);
  return result.manifest;
};

const harness = (options: { detectFramework?: (folder: string, spec: { name: string }) => Promise<string | null>; loaded?: LoadedManifest; iterm?: boolean; allow?: boolean; launch?: { code: number; stderr: string }; discovered?: Array<{ label: string; folder: string }>; readmes?: Record<string, string>; openDocument?: { ok: true } | { ok: false; message: string }; passcodeFiles?: Record<string, string>; candidates?: Record<string, PasscodeBinding[]>; packages?: string[]; installers?: Record<string, InstallManager>; reinstallAllow?: boolean; sweep?: PortSweepResult; portsFiles?: Record<string, Record<string, number>> } = {}, extra: { earlyExitCheckMs?: number } = {}) => {
  /** 資料夾裡目前的殘留程序；結束後清空。 */
  const staleState = { list: [] as StaleProcess[], allow: true, ended: [] as number[][], confirms: 0, failEnd: false, releases: [] as Array<{ service: string; ports: number[] }> };
  const db = createTestDb();
  /** 有 package.json 的資料夾（絕對路徑）。 */
  const packageFiles = new Set((options.packages ?? []).map((dir) => `${dir}/package.json`));
  const reinstallConfirms: ConfirmReinstallRequest[] = [];
  const sweepCalls: string[] = [];
  const listening = new Set<number>();
  const launched: ItermTab[][] = [];
  const opened: string[] = [];
  const documents: string[] = [];
  const confirms: ConfirmCommandsRequest[] = [];
  const written: Array<{ folder: string; services: Record<string, { port: number; role: string }> }> = [];
  const stopped: number[][] = [];
  const closed: string[][] = [];
  const simulators: MobilePlatform[] = [];
  const simulatorDevices: (string | null | undefined)[] = [];
  /** 外部動作發生的先後：launch、stopPorts、closeTabs、simulator:<平台>。 */
  const events: string[] = [];
  /** 結束後還要被探測幾次才會釋放的 port（模擬收尾較慢的程序）。 */
  const pending = new Map<number, number>();
  const logs: string[] = [];
  const copied: string[] = [];
  const cipher = createFakeCipher();
  const vault = createVault(db, cipher);
  /** 環境檔內容：鍵是「資料夾::相對路徑」；讀取用真正的 dotenv 解析。 */
  const passcodeFiles = new Map<string, string>(Object.entries(options.passcodeFiles ?? {}));
  const candidates: Record<string, PasscodeBinding[]> = { ...(options.candidates ?? {}) };
  const scans: Array<{ folder: string; serviceDirs: string[] }> = [];
  const passcodeSource: PasscodeSourceReader = {
    read: async (folder, binding) => {
      const text = passcodeFiles.get(`${folder}::${binding.file}`);
      return text === undefined ? { state: "no-file", value: null } : interpretEnvText(text, binding.key);
    },
    scan: async (folder, input) => {
      scans.push({ folder, serviceDirs: [...input.serviceDirs] });
      return candidates[folder] ?? [];
    },
    locate: async (folder, binding) => (passcodeFiles.has(`${folder}::${binding.file}`) ? `${folder}/${binding.file}` : null)
  };
  let next = 41000;
  let time = 1_000_000;
  let loaded: LoadedManifest = options.loaded ?? { status: "ok", manifest: manifestOf(), hash: "a".repeat(64) };
  const state = {
    iterm: options.iterm ?? true,
    allow: options.allow ?? true,
    launch: options.launch ?? { code: 0, stderr: "" },
    stop: { code: 0, stderr: "" },
    /** 結束後 port 何時釋放：立刻、探測兩次後、永遠不釋放。 */
    release: "now" as "now" | "slow" | "never",
    close: { code: 0, stderr: "" },
    simulator: { code: 0, stderr: "" }
  };

  const handlers = createRunHandlers({
    db,
    logger: { log: (entry) => void logs.push(entry.message) },
    loadManifest: async () => loaded,
    probe: async (port) => {
      const left = pending.get(port);
      if (left !== undefined) {
        if (left <= 0) {
          pending.delete(port);
          listening.delete(port);
        } else {
          pending.set(port, left - 1);
        }
      }
      return listening.has(port);
    },
    allocatePorts: async (count) => Array.from({ length: count }, () => (next += 1)),
    writePortsFile: async (folder, services) => {
      written.push({ folder, services });
      return true;
    },
    readPortsFile: async (folder) => options.portsFiles?.[folder] ?? null,
    discoverFolders: () => options.discovered ?? [],
    itermAvailable: () => state.iterm,
    inspect: async (path) => (path === "/work/file" || packageFiles.has(path) ? "file" : path.startsWith("/work/") ? "dir" : "missing"),
    launchTabs: async (tabs) => {
      events.push("launch");
      launched.push(tabs);
      return state.launch;
    },
    stopPorts: async (ports) => {
      events.push("stopPorts");
      stopped.push(ports);
      if (state.stop.code === 0) {
        for (const port of ports) {
          if (state.release === "now") listening.delete(port);
          else if (state.release === "slow") pending.set(port, 2);
        }
      }
      return state.stop;
    },
    closeTabs: async (sessionNames) => {
      events.push("closeTabs");
      closed.push(sessionNames);
      return state.close;
    },
    closeSimulator: async (platform, deviceId) => {
      events.push(`simulator:${platform}`);
      simulators.push(platform);
      simulatorDevices.push(deviceId);
      return state.simulator;
    },
    confirmCommands: async (request) => {
      confirms.push(request);
      return state.allow;
    },
    confirmReinstall: async (request) => {
      reinstallConfirms.push(request);
      return options.reinstallAllow ?? true;
    },
    detectInstaller: async (dir, inherited) => options.installers?.[dir] ?? inherited ?? "npm",
    portSweep: {
      scan: async () => {
        sweepCalls.push("scan");
        return { targets: [...(options.sweep?.ended ?? []), ...(options.sweep?.failed ?? [])] };
      },
      release: async () => {
        sweepCalls.push("release");
        return options.sweep ?? { ended: [], failed: [] };
      }
    },
    staleProcesses: {
      scan: async () => [...staleState.list],
      end: async (list) => {
        staleState.ended.push(list.map((item) => item.pid));
        if (staleState.failEnd) return { failed: [...list] };
        staleState.list = [];
        return { failed: [] };
      }
    },
    confirmStale: async () => {
      staleState.confirms += 1;
      return staleState.allow;
    },
    confirmRelease: async (request) => {
      staleState.releases.push({ service: request.service, ports: request.ports });
      return staleState.allow;
    },
    earlyExitCheckMs: extra.earlyExitCheckMs ?? 0,
    openUrl: async (url) => void opened.push(url),
    ...(options.detectFramework === undefined ? {} : { detectFramework: options.detectFramework }),
    findReadme: (folder) => options.readmes?.[folder] ?? null,
    openDocument: async (path) => {
      documents.push(path);
      return options.openDocument ?? { ok: true };
    },
    vault,
    copySecret: async (secret) => void copied.push(secret),
    passcodeSource,
    now: () => time,
    startingGraceMs: 60_000,
    portRelease: { timeoutMs: 20, pollMs: 1 }
  });

  const project = (localPath: string | null = "/work/app") =>
    addProject(db, {
      owner: "acme",
      repo: `r${Math.random().toString(36).slice(2, 8)}`,
      name: "app",
      localPath,
      branchFilter: ["*"],
      pollIntervalSec: 30,
      mode: "poll",
      enabled: true,
      aiEnabled: false
    });

  return {
    db,
    handlers,
    staleState,
    listening,
    launched,
    stopped,
    closed,
    simulators,
    simulatorDevices,
    events,
    opened,
    documents,
    confirms,
    reinstallConfirms,
    sweepCalls,
    written,
    logs,
    copied,
    cipher,
    vault,
    passcodeFiles,
    candidates,
    scans,
    state,
    project,
    setLoaded: (value: LoadedManifest) => void (loaded = value),
    advance: (ms: number) => void (time += ms)
  };
};

const ok = (value: { ok: boolean }): void => assert.equal(value.ok, true, JSON.stringify(value));
const serviceAction = (service: string, action: RunServiceActionName): RunAction => ({ scope: "service", service, action });
const stopProject: RunAction = { scope: "project", action: "stop" };

describe("run handlers: listing", () => {
  it("lists projects that have a local path plus added folders, without duplicates", async () => {
    const h = harness({ discovered: [{ label: "auto", folder: "/work/auto" }, { label: "dupe", folder: "/work/app" }] });
    const first = h.project("/work/app");
    h.project(null);
    await h.handlers.addFolder("/work/extra");
    await h.handlers.addFolder("/work/app");
    const overview = await h.handlers.overview();
    assert.deepEqual(overview.targets.map((target) => [target.id, target.source, target.folder]), [
      [`p:${first.id}`, "project", "/work/app"],
      ["f:1", "folder", "/work/extra"],
      [overview.targets[2]?.id, "discovered", "/work/auto"]
    ]);
    assert.match(overview.targets[2]?.id ?? "", /^f:[1-9]\d{0,8}$/);
  });

  it("carries a project's pathExists onto its target, but not onto folder or discovered targets", async () => {
    const h = harness({ discovered: [{ label: "auto", folder: "/work/auto" }] });
    const missing = h.project("/definitely/not/a/real/path/xyz");
    await h.handlers.addFolder("/work/extra");
    const overview = await h.handlers.overview();
    assert.deepEqual(
      overview.targets.map((target) => [target.id, target.source, target.pathExists]),
      [
        [`p:${missing.id}`, "project", false],
        ["f:1", "folder", undefined],
        [overview.targets[2]?.id, "discovered", undefined]
      ]
    );
  });

  it("認回重開後仍在跑的服務：固定 port 直接探測，動態 port 配合上次寫的 ports.json", async () => {
    const h = harness({ loaded: { status: "ok", manifest: fixedManifestOf(), hash: "a".repeat(64) } });
    h.project("/work/app");
    h.listening.add(5174); // api 的固定 port，實際還在監聽（GitNRun 重開前就啟動的）
    h.listening.add(41777); // web 的動態 port，記錄在上次寫的 ports.json
    // 還沒告訴它上次的 ports.json 內容，動態 port 的 web 仍應該是 stopped。
    const overviewBefore = await h.handlers.overview();
    assert.deepEqual(overviewBefore.targets[0]?.services.map((s) => [s.name, s.state, s.port]), [
      ["api", "running", 5174],
      ["web", "stopped", null]
    ]);

    const h2 = harness({
      loaded: { status: "ok", manifest: fixedManifestOf(), hash: "a".repeat(64) },
      portsFiles: { "/work/app": { web: 41777 } }
    });
    h2.project("/work/app");
    h2.listening.add(5174);
    h2.listening.add(41777);
    const overview = await h2.handlers.overview();
    assert.deepEqual(overview.targets[0]?.services.map((s) => [s.name, s.state, s.port]), [
      ["api", "running", 5174],
      ["web", "running", 41777]
    ]);

    // 服務之後真的掛了，下次刷新要正確回報 stopped，不是卡在認回時的狀態。
    h2.listening.delete(5174);
    h2.listening.delete(41777);
    const overviewAfterDeath = await h2.handlers.overview();
    assert.deepEqual(overviewAfterDeath.targets[0]?.services.map((s) => [s.name, s.state]), [
      ["api", "stopped"],
      ["web", "stopped"]
    ]);
  });

  it("記錄在 ports.json 裡、但其實已經沒人監聽的 port 不會被誤認成還在跑", async () => {
    const h = harness({
      loaded: { status: "ok", manifest: fixedManifestOf(), hash: "a".repeat(64) },
      portsFiles: { "/work/app": { web: 41778 } }
    });
    h.project("/work/app");
    // 故意不讓 41778 和 5174 進入 listening：兩個都該被判定為 stopped。
    const overview = await h.handlers.overview();
    assert.deepEqual(overview.targets[0]?.services.map((s) => [s.name, s.state]), [
      ["api", "stopped"],
      ["web", "stopped"]
    ]);
  });

  it("shows services as stopped with commands, and explains a missing manifest", async () => {
    const h = harness();
    h.project();
    const [target] = (await h.handlers.overview()).targets;
    assert.equal(target?.manifest, "ok");
    assert.deepEqual(target?.services.map((service) => [service.name, service.state, service.url]), [["api", "stopped", null], ["web", "stopped", null], ["panel", "stopped", null]]);
    assert.equal(target?.services[0]?.command, "DEV_PORT={port} FRONT={web.url} pnpm dev");
    assert.equal(target?.trusted, false);

    h.setLoaded({ status: "missing" });
    const missing = (await h.handlers.overview()).targets[0];
    assert.equal(missing?.manifest, "missing");
    assert.equal(missing?.buttons.all.enabled, false);
    h.setLoaded({ status: "invalid", errors: ["壞了"] });
    const invalid = (await h.handlers.overview()).targets[0];
    assert.deepEqual(invalid?.errors, ["壞了"]);
  });

  it("reports the detected framework per service, and survives a detection failure", async () => {
    const h = harness({
      detectFramework: async (_folder, spec) => {
        if (spec.name === "api") return "Django";
        if (spec.name === "web") throw new Error("boom");
        return null;
      }
    });
    h.project();
    const [target] = (await h.handlers.overview()).targets;
    assert.deepEqual(target?.services.map((service) => [service.name, service.framework]), [["api", "Django"], ["web", null], ["panel", null]]);
  });

  it("validates folders before adding them", async () => {
    const h = harness();
    await assert.rejects(h.handlers.addFolder("relative/path"), UserFacingError);
    await assert.rejects(h.handlers.addFolder("/work/../etc"), UserFacingError);
    await assert.rejects(h.handlers.addFolder("/nowhere"), UserFacingError);
    await assert.rejects(h.handlers.addFolder("/work/file"), UserFacingError);
    assert.throws(() => h.handlers.removeFolder("p:3"), UserFacingError);
  });
});

describe("run handlers: one-click start", () => {
  it("uses a fixed API port while allocating the frontend port dynamically", async () => {
    const h = harness({ loaded: { status: "ok", manifest: fixedManifestOf(), hash: "f".repeat(64) } });
    const project = h.project();
    const target = `p:${project.id}`;
    ok(await h.handlers.run(target, serviceAction("web", "start")));
    assert.equal(h.launched[0]?.[0]?.command, "env PORT=5174 pnpm dev");
    assert.equal(h.launched[0]?.[1]?.command, "env PORT=41001 API=http://localhost:5174 pnpm dev");
    assert.equal((await h.handlers.overview()).targets[0]?.services[0]?.fixedPort, 5174);
    h.listening.add(5174);
    h.listening.add(41001);
    ok(await h.handlers.run(target, serviceAction("web", "restart")));
    assert.deepEqual(h.launched[1]?.map((tab) => tab.name), [`gitnrun p:${project.id} web`]);
    assert.equal(h.launched[1]?.[0]?.command, "env PORT=41001 API=http://localhost:5174 pnpm dev");
  });

  it("refuses an occupied fixed port without launching or stopping its owner", async () => {
    const h = harness({ loaded: { status: "ok", manifest: fixedManifestOf(), hash: "f".repeat(64) } });
    const project = h.project();
    h.listening.add(5174);
    const result = await h.handlers.run(`p:${project.id}`, serviceAction("api", "start"));
    assert.equal(result.ok, false);
    assert.match(result.message, /5174.*占用/);
    assert.deepEqual(h.launched, []);
    assert.deepEqual(h.stopped, []);
  });

  it("opens one tab per backend/frontend service in order, with ports wired together", async () => {
    const h = harness();
    const project = h.project();
    ok(await h.handlers.run(`p:${project.id}`, serviceAction("web", "start")));

    assert.equal(h.launched.length, 1);
    assert.deepEqual(h.launched[0]?.map((tab) => [tab.name, tab.dir]), [["gitnrun p:1 api", "/work/app/api"], ["gitnrun p:1 web", "/work/app"]]);
    assert.equal(h.launched[0]?.[0]?.command, "env DEV_PORT=41001 FRONT=http://localhost:41002 pnpm dev");
    assert.equal(h.launched[0]?.[1]?.command, "env PORT=41002 API=http://localhost:41001 pnpm dev");
    assert.deepEqual(h.written[0]?.services, { api: { role: "backend", port: 41001 }, web: { role: "frontend", port: 41002 } });
    assert.ok(h.logs.some((line) => line.includes("已在 iTerm2 啟動")));
  });

  it("reports services as starting, then running once they listen, then stopped again", async () => {
    const h = harness();
    const project = h.project();
    await h.handlers.run(`p:${project.id}`, serviceAction("web", "start"));

    const starting = (await h.handlers.overview()).targets[0];
    assert.deepEqual(starting?.services.map((service) => service.state), ["starting", "starting", "stopped"]);
    assert.equal(starting?.buttons.all.reason, "已在執行中");

    h.listening.add(41001);
    h.listening.add(41002);
    const running = (await h.handlers.overview()).targets[0];
    assert.deepEqual(running?.services.map((service) => [service.state, service.url]), [["running", "http://localhost:41001"], ["running", "http://localhost:41002"], ["stopped", null]]);
    assert.equal(running?.buttons.web.enabled, true);

    h.listening.clear();
    h.advance(61_000);
    const stopped = (await h.handlers.overview()).targets[0];
    assert.deepEqual(stopped?.services.map((service) => service.state), ["stopped", "stopped", "stopped"]);
  });

  it("does not start anything twice", async () => {
    const h = harness();
    const project = h.project();
    await h.handlers.run(`p:${project.id}`, serviceAction("web", "start"));
    h.listening.add(41001);
    h.listening.add(41002);
    const again = await h.handlers.run(`p:${project.id}`, serviceAction("web", "start"));
    ok(again);
    assert.equal(h.launched.length, 1);
    assert.match(again.ok ? again.message : "", /已經在執行中/);
  });

  it("restarts backend/frontend services on the same ports", async () => {
    const h = harness();
    const project = h.project();
    await h.handlers.run(`p:${project.id}`, serviceAction("web", "start"));
    h.listening.add(41001);
    h.listening.add(41002);

    ok(await h.handlers.run(`p:${project.id}`, serviceAction("web", "restart")));

    assert.equal(h.launched.length, 2);
    assert.deepEqual(h.launched[1]?.map((tab) => tab.name), ["gitnrun p:1 web"]);
    assert.equal(h.launched[1]?.[0]?.command, "env PORT=41002 API=http://localhost:41001 pnpm dev");
    assert.deepEqual(h.stopped, [[41002]]);
    assert.deepEqual(h.closed, [["gitnrun p:1 web"]]);
    assert.deepEqual(h.written.at(-1)?.services, { api: { role: "backend", port: 41001 }, web: { role: "frontend", port: 41002 } });
  });

  it("restarting the frontend leaves the backend untouched, and restarting the backend leaves the frontend", async () => {
    const h = harness();
    const project = h.project();
    const target = `p:${project.id}`;
    await h.handlers.run(target, serviceAction("web", "start"));
    h.listening.add(41001);
    h.listening.add(41002);
    ok(await h.handlers.run(target, serviceAction("api", "restart")));
    assert.deepEqual(h.launched[1]?.map((tab) => tab.name), [`gitnrun p:${project.id} api`]);
    assert.deepEqual(h.stopped, [[41001]]);
  });

  it("starts the backend a frontend restart depends on when it is not running", async () => {
    const h = harness();
    const project = h.project();
    ok(await h.handlers.run(`p:${project.id}`, serviceAction("web", "restart")));
    assert.deepEqual(h.launched[0]?.map((tab) => tab.name), [`gitnrun p:${project.id} api`, `gitnrun p:${project.id} web`]);
  });

  it("starts the shared backend only once when two frontends are started at the same time", async () => {
    const h = harness();
    const project = h.project();
    const target = `p:${project.id}`;
    await Promise.all([h.handlers.run(target, serviceAction("web", "start")), h.handlers.run(target, serviceAction("panel", "start"))]);
    const names = h.launched.flat().map((tab) => tab.name);
    assert.equal(names.filter((name) => name.endsWith(" api")).length, 1);
  });

  describe("restart ends the old services first", () => {
    const startedHarness = async (options: Parameters<typeof harness>[0] = {}) => {
      const h = harness(options);
      const project = h.project();
      await h.handlers.run(`p:${project.id}`, serviceAction("web", "start"));
      h.listening.add(41001);
      h.listening.add(41002);
      return { h, targetId: `p:${project.id}` };
    };

    it("stops the ports and closes the old tabs before opening the new ones", async () => {
      const { h, targetId } = await startedHarness();

      const result = await h.handlers.run(targetId, serviceAction("web", "restart"));

      ok(result);
      assert.deepEqual(h.events, ["launch", "stopPorts", "closeTabs", "launch"]);
      assert.match(result.message, /已結束 1 個服務並關閉終端機分頁：web，已在 iTerm2 重新開啟 1 個分頁：web/);
      assert.deepEqual((await h.handlers.overview()).targets[0]?.services.map((service) => service.state), ["running", "starting", "stopped"]);
    });

    it("does not open new tabs when the old services cannot be stopped", async () => {
      const { h, targetId } = await startedHarness();
      h.state.stop = { code: 1, stderr: "kill 失敗" };

      const result = await h.handlers.run(targetId, serviceAction("web", "restart"));

      assert.deepEqual([result.ok, result.ok ? "" : result.reason], [false, "failed"]);
      assert.match(result.message, /無法結束：kill 失敗/);
      assert.equal(h.launched.length, 1);
      assert.deepEqual(h.closed, []);
    });

    it("does not open new tabs when macOS refuses to close the old tabs", async () => {
      const { h, targetId } = await startedHarness();
      h.state.close = { code: 1, stderr: "not authorized to send apple events (-1743)" };

      const result = await h.handlers.run(targetId, serviceAction("web", "restart"));

      assert.deepEqual([result.ok, result.ok ? "" : result.reason], [false, "permission-denied"]);
      assert.equal(h.launched.length, 1);
    });

    it("leaves the running services alone when the user denies a changed manifest", async () => {
      const { h, targetId } = await startedHarness();
      h.setLoaded({ status: "ok", manifest: manifestOf(), hash: "b".repeat(64) });
      h.state.allow = false;

      const result = await h.handlers.run(targetId, serviceAction("web", "restart"));

      assert.deepEqual([result.ok, result.ok ? "" : result.reason], [false, "denied"]);
      assert.deepEqual(h.events, ["launch"]);
      assert.deepEqual((await h.handlers.overview()).targets[0]?.services.map((service) => service.state), ["running", "running", "stopped"]);
    });

    it("still opens the services when nothing was running", async () => {
      const h = harness();
      const project = h.project();

      const result = await h.handlers.run(`p:${project.id}`, serviceAction("web", "restart"));

      ok(result);
      assert.deepEqual(h.events, ["launch"]);
      assert.equal(h.launched[0]?.[0]?.command, "env DEV_PORT=41001 FRONT=http://localhost:41002 pnpm dev");
    });

    it("waits for a slow old service to release its port before opening new tabs", async () => {
      const { h, targetId } = await startedHarness();
      h.state.release = "slow";

      ok(await h.handlers.run(targetId, serviceAction("web", "restart")));

      assert.deepEqual(h.events, ["launch", "stopPorts", "closeTabs", "launch"]);
      assert.equal(h.launched.length, 2);
    });

    it("does not open new tabs while an old service still holds its port", async () => {
      const { h, targetId } = await startedHarness();
      h.state.release = "never";

      const result = await h.handlers.run(targetId, serviceAction("web", "restart"));

      assert.deepEqual([result.ok, result.ok ? "" : result.reason], [false, "failed"]);
      assert.match(result.message, /舊服務仍占用 port 41002/);
      assert.equal(h.launched.length, 1);
    });
  });

  it("stops active services and clears their recorded ports", async () => {
    const h = harness();
    const project = h.project();
    await h.handlers.run(`p:${project.id}`, serviceAction("web", "start"));
    h.listening.add(41001);
    h.listening.add(41002);

    ok(await h.handlers.run(`p:${project.id}`, stopProject));

    assert.deepEqual(h.stopped, [[41001, 41002]]);
    assert.deepEqual((await h.handlers.overview()).targets[0]?.services.map((service) => service.state), ["stopped", "stopped", "stopped"]);
    assert.deepEqual(h.written.at(-1)?.services, {});
  });

  it("can stop only one selected service", async () => {
    const h = harness();
    const project = h.project();
    await h.handlers.run(`p:${project.id}`, serviceAction("web", "start"));
    h.listening.add(41001);
    h.listening.add(41002);

    ok(await h.handlers.run(`p:${project.id}`, serviceAction("web", "stop")));

    assert.deepEqual(h.stopped, [[41002]]);
    assert.deepEqual((await h.handlers.overview()).targets[0]?.services.map((service) => service.state), ["running", "stopped", "stopped"]);
    assert.deepEqual(h.written.at(-1)?.services, { api: { role: "backend", port: 41001 } });
  });

  it("closes the iTerm2 tabs of the services it ends, and only those", async () => {
    const h = harness();
    const project = h.project();
    await h.handlers.run(`p:${project.id}`, serviceAction("web", "start"));
    h.listening.add(41001);
    h.listening.add(41002);

    ok(await h.handlers.run(`p:${project.id}`, serviceAction("web", "stop")));
    assert.deepEqual(h.closed, [["gitnrun p:1 web"]]);

    ok(await h.handlers.run(`p:${project.id}`, stopProject));
    assert.deepEqual(h.closed.at(-1), ["gitnrun p:1 api"]);
  });

  it("closes the tab of a service that already died, even though no port is listening", async () => {
    const h = harness();
    const project = h.project();
    await h.handlers.run(`p:${project.id}`, serviceAction("web", "start"));
    h.listening.add(41001);
    h.advance(61_000);

    ok(await h.handlers.run(`p:${project.id}`, stopProject));

    assert.deepEqual(h.stopped, [[41001]]);
    assert.deepEqual(h.closed, [["gitnrun p:1 api", "gitnrun p:1 web"]]);
  });

  it("reports a tab-closing failure after the services were already ended", async () => {
    const h = harness();
    const project = h.project();
    await h.handlers.run(`p:${project.id}`, serviceAction("web", "start"));
    h.listening.add(41001);
    h.listening.add(41002);
    h.state.close = { code: 1, stderr: "not authorized to send apple events (-1743)" };

    const result = await h.handlers.run(`p:${project.id}`, stopProject);

    assert.deepEqual([result.ok, result.ok ? "" : result.reason], [false, "permission-denied"]);
    assert.deepEqual(h.stopped, [[41001, 41002]]);
    assert.deepEqual((await h.handlers.overview()).targets[0]?.services.map((service) => service.state), ["stopped", "stopped", "stopped"]);
  });

  describe("mobile services", () => {
    const mobileHarness = (options: Parameters<typeof harness>[0] = {}) =>
      harness({ loaded: { status: "ok", manifest: mobileManifestOf(), hash: "m".repeat(64) }, ...options });

    it("closes only the iOS simulator when the iOS service is ended", async () => {
      const h = mobileHarness();
      const project = h.project();
      await h.handlers.run(`p:${project.id}`, serviceAction("mobile-anipurr-ios", "start"));
      await h.handlers.run(`p:${project.id}`, serviceAction("mobile-anipurr-android", "start"));

      const result = await h.handlers.run(`p:${project.id}`, serviceAction("mobile-anipurr-ios", "stop"));

      ok(result);
      assert.deepEqual(h.simulators, ["ios"]);
      assert.match(result.message, /iOS 模擬器/);
      assert.deepEqual(h.closed.at(-1), ["gitnrun p:1 mobile-anipurr-ios"]);
    });

    it("closes only the Android emulator when the Android service is ended", async () => {
      const h = mobileHarness();
      const project = h.project();
      await h.handlers.run(`p:${project.id}`, serviceAction("mobile-anipurr-ios", "start"));
      await h.handlers.run(`p:${project.id}`, serviceAction("mobile-anipurr-android", "start"));

      ok(await h.handlers.run(`p:${project.id}`, serviceAction("mobile-anipurr-android", "stop")));

      assert.deepEqual(h.simulators, ["android"]);
    });

    it("shuts down only the simulator bound to the stopped service", async () => {
      const udid = "11111111-2222-3333-4444-555555555555";
      const manifest = mobileManifestOf();
      const bound: RunManifest = {
        ...manifest,
        services: manifest.services.map((spec) => (spec.name === "mobile-anipurr-ios" ? { ...spec, command: ["zsh", "-lc", iosRunScript(udid)] } : spec))
      };
      const h = harness({ loaded: { status: "ok", manifest: bound, hash: "m".repeat(64) } });
      const project = h.project();
      await h.handlers.run(`p:${project.id}`, serviceAction("mobile-anipurr-ios", "start"));
      await h.handlers.run(`p:${project.id}`, serviceAction("mobile-anipurr-ios", "stop"));

      assert.deepEqual(h.simulatorDevices, [udid]);
    });

    it("leaves simulators alone when an ordinary service is ended", async () => {
      const h = mobileHarness();
      const project = h.project();
      await h.handlers.run(`p:${project.id}`, serviceAction("web", "start"));
      await h.handlers.run(`p:${project.id}`, serviceAction("mobile-anipurr-ios", "start"));
      h.listening.add(41001);

      ok(await h.handlers.run(`p:${project.id}`, serviceAction("web", "stop")));

      assert.deepEqual(h.simulators, []);
    });

    it("closes the simulators of the mobile services that were started when the whole project is ended", async () => {
      const h = mobileHarness();
      const project = h.project();
      await h.handlers.run(`p:${project.id}`, serviceAction("mobile-anipurr-android", "start"));

      ok(await h.handlers.run(`p:${project.id}`, stopProject));

      assert.deepEqual(h.simulators, ["android"]);
    });

    it("does not touch simulators for a mobile service that was never started", async () => {
      const h = mobileHarness();
      const project = h.project();
      await h.handlers.run(`p:${project.id}`, serviceAction("mobile-anipurr-ios", "start"));

      const result = await h.handlers.run(`p:${project.id}`, serviceAction("mobile-anipurr-android", "stop"));

      assert.deepEqual([result.ok, result.ok ? "" : result.reason], [false, "nothing-to-do"]);
      assert.deepEqual(h.simulators, []);
    });

    it("reports a simulator failure after the service was already ended, and still clears its state", async () => {
      const h = mobileHarness();
      const project = h.project();
      await h.handlers.run(`p:${project.id}`, serviceAction("mobile-anipurr-ios", "start"));
      h.state.simulator = { code: 127, stderr: "找不到 xcrun" };

      const result = await h.handlers.run(`p:${project.id}`, serviceAction("mobile-anipurr-ios", "stop"));

      assert.deepEqual([result.ok, result.ok ? "" : result.reason], [false, "failed"]);
      assert.match(result.message, /服務已結束，但無法關閉 iOS 模擬器：找不到 xcrun/);
      assert.deepEqual((await h.handlers.overview()).targets[0]?.services.map((service) => service.state), ["stopped", "stopped", "stopped"]);
    });

    it("still closes the simulator when the iTerm2 tab could not be closed", async () => {
      const h = mobileHarness();
      const project = h.project();
      await h.handlers.run(`p:${project.id}`, serviceAction("mobile-anipurr-ios", "start"));
      h.state.close = { code: 1, stderr: "not authorized to send apple events (-1743)" };

      const result = await h.handlers.run(`p:${project.id}`, serviceAction("mobile-anipurr-ios", "stop"));

      assert.deepEqual([result.ok, result.ok ? "" : result.reason], [false, "permission-denied"]);
      assert.deepEqual(h.simulators, ["ios"]);
    });

    it("closes the old tab and the iOS simulator before restarting the iOS service, and leaves Android alone", async () => {
      const h = mobileHarness();
      const project = h.project();
      await h.handlers.run(`p:${project.id}`, serviceAction("mobile-anipurr-ios", "start"));
      await h.handlers.run(`p:${project.id}`, serviceAction("mobile-anipurr-android", "start"));

      const result = await h.handlers.run(`p:${project.id}`, serviceAction("mobile-anipurr-ios", "restart"));

      ok(result);
      assert.deepEqual(h.events.slice(2), ["closeTabs", "simulator:ios", "launch"]);
      assert.deepEqual(h.closed.at(-1), ["gitnrun p:1 mobile-anipurr-ios"]);
      assert.deepEqual(h.simulators, ["ios"]);
      assert.deepEqual(h.launched.at(-1)?.map((tab) => tab.name), ["gitnrun p:1 mobile-anipurr-ios"]);
      assert.doesNotMatch(h.launched.at(-1)?.[0]?.command ?? "", /kill/);
      assert.match(result.message, /並關閉 iOS 模擬器，已在 iTerm2 重新開啟 1 個分頁/);
    });

    it("does not open a new tab when the simulator cannot be closed during a restart", async () => {
      const h = mobileHarness();
      const project = h.project();
      await h.handlers.run(`p:${project.id}`, serviceAction("mobile-anipurr-ios", "start"));
      h.state.simulator = { code: 127, stderr: "找不到 xcrun" };

      const result = await h.handlers.run(`p:${project.id}`, serviceAction("mobile-anipurr-ios", "restart"));

      assert.deepEqual([result.ok, result.ok ? "" : result.reason], [false, "failed"]);
      assert.equal(h.launched.length, 1);
    });
  });

  it("does not clear other running services when a selected stopped service is stopped", async () => {
    const h = harness();
    const project = h.project();
    await h.handlers.run(`p:${project.id}`, serviceAction("web", "start"));
    h.listening.add(41001);
    h.listening.add(41002);
    const result = await h.handlers.run(`p:${project.id}`, serviceAction("panel", "stop"));

    assert.deepEqual([result.ok, result.ok ? "" : result.reason], [false, "nothing-to-do"]);
    assert.deepEqual(h.stopped, []);
    assert.deepEqual((await h.handlers.overview()).targets[0]?.services.map((service) => service.state), ["running", "running", "stopped"]);
    assert.deepEqual(h.written.at(-1)?.services, { api: { role: "backend", port: 41001 }, web: { role: "frontend", port: 41002 } });
  });

  it("starts one selected frontend without starting sibling frontends", async () => {
    const h = harness({ loaded: { status: "ok", manifest: multiFrontendManifestOf(), hash: "m".repeat(64) } });
    const project = h.project();
    ok(await h.handlers.run(`p:${project.id}`, serviceAction("sparkpurr", "start")));

    assert.deepEqual(h.launched[0]?.map((tab) => tab.name), ["gitnrun p:1 api", "gitnrun p:1 sparkpurr"]);
    assert.equal(h.launched[0]?.[1]?.command, "env PORT=41003 API=http://localhost:41001 pnpm dev:spark");
    assert.deepEqual(h.written[0]?.services, { api: { role: "backend", port: 41001 }, sparkpurr: { role: "frontend", port: 41003 } });
  });

  it("starts only what is down and keeps the running service's port", async () => {
    const h = harness();
    const project = h.project();
    await h.handlers.run(`p:${project.id}`, serviceAction("web", "start"));
    h.listening.add(41001);
    h.advance(61_000);
    ok(await h.handlers.run(`p:${project.id}`, serviceAction("web", "start")));

    assert.equal(h.launched.length, 2);
    assert.deepEqual(h.launched[1]?.map((tab) => tab.name), ["gitnrun p:1 web"]);
    // 第一次配置時三個有 port 的服務各拿一個（41001～41003）；第二次只有 web、panel 需要新的。
    assert.equal(h.launched[1]?.[0]?.command, "env PORT=41004 API=http://localhost:41001 pnpm dev");
  });

  it("the desktop action starts its needed service and reuses one that is already running", async () => {
    const h = harness();
    const project = h.project();
    ok(await h.handlers.run(`p:${project.id}`, serviceAction("panel", "start")));
    assert.deepEqual(h.launched[0]?.map((tab) => tab.name), ["gitnrun p:1 api", "gitnrun p:1 panel"]);

    const second = harness();
    const other = second.project();
    await second.handlers.run(`p:${other.id}`, serviceAction("web", "start"));
    second.listening.add(41001);
    ok(await second.handlers.run(`p:${other.id}`, serviceAction("panel", "start")));
    assert.deepEqual(second.launched[1]?.map((tab) => tab.name), ["gitnrun p:1 panel"]);
    assert.match(second.launched[1]?.[0]?.command ?? "", /API=http:\/\/localhost:41001/);
  });

  it("never touches the terminal setting: it needs iTerm2 and says so when it is missing", async () => {
    const h = harness({ iterm: false });
    const project = h.project();
    const result = await h.handlers.run(`p:${project.id}`, serviceAction("web", "start"));
    assert.deepEqual([result.ok, result.ok ? "" : result.reason], [false, "iterm-missing"]);
    assert.equal(h.launched.length, 0);
    assert.equal(h.confirms.length, 0);
  });

  it("maps a denied macOS automation permission and other launch errors", async () => {
    const denied = harness({ launch: { code: 1, stderr: "execution error: Not authorized to send Apple events to iTerm. (-1743)" } });
    const a = denied.project();
    const result = await denied.handlers.run(`p:${a.id}`, serviceAction("web", "start"));
    assert.deepEqual([result.ok, result.ok ? "" : result.reason], [false, "permission-denied"]);

    const broken = harness({ launch: { code: 1, stderr: "boom" } });
    const b = broken.project();
    const failed = await broken.handlers.run(`p:${b.id}`, serviceAction("web", "start"));
    assert.deepEqual([failed.ok, failed.ok ? "" : failed.reason], [false, "failed"]);
    // 沒啟動成功就不能留下「啟動中」的假狀態。
    assert.deepEqual((await broken.handlers.overview()).targets[0]?.services.map((service) => service.state), ["stopped", "stopped", "stopped"]);
  });

  it("rejects unknown targets and manifests that are missing or invalid", async () => {
    const h = harness();
    const project = h.project();
    const unknown = await h.handlers.run("p:999", serviceAction("web", "start"));
    assert.deepEqual([unknown.ok, unknown.ok ? "" : unknown.reason], [false, "unknown-target"]);
    h.setLoaded({ status: "missing" });
    const missing = await h.handlers.run(`p:${project.id}`, serviceAction("web", "start"));
    assert.deepEqual([missing.ok, missing.ok ? "" : missing.reason], [false, "no-manifest"]);
    h.setLoaded({ status: "invalid", errors: ["x"] });
    const invalid = await h.handlers.run(`p:${project.id}`, serviceAction("web", "start"));
    assert.deepEqual([invalid.ok, invalid.ok ? "" : invalid.reason], [false, "invalid-manifest"]);
    assert.equal(h.launched.length, 0);
  });

  it("says there is nothing to do when the project has no such services", async () => {
    const result = validateManifest({ version: 1, services: [{ name: "panel", role: "desktop", command: ["pnpm", "dev"], port: true }] });
    assert.ok(result.ok);
    const h = harness({ loaded: { status: "ok", manifest: result.manifest, hash: "b".repeat(64) } });
    const project = h.project();
    const none = await h.handlers.run(`p:${project.id}`, serviceAction("web", "start"));
    assert.deepEqual([none.ok, none.ok ? "" : none.reason], [false, "unknown-service"]);
  });
});

describe("run handlers: trust confirmation", () => {
  it("asks before the first run, lists every command, and remembers the answer", async () => {
    const h = harness();
    const project = h.project();
    ok(await h.handlers.run(`p:${project.id}`, serviceAction("web", "start")));
    assert.equal(h.confirms.length, 1);
    assert.equal(h.confirms[0]?.changed, false);
    assert.deepEqual(h.confirms[0]?.lines.map((line) => line.service), ["api", "web", "panel"]);
    assert.equal(isRunTrusted(h.db, "/work/app", "a".repeat(64)), true);

    h.advance(61_000);
    ok(await h.handlers.run(`p:${project.id}`, serviceAction("web", "start")));
    assert.equal(h.confirms.length, 1);
  });

  it("sends nothing to iTerm2 when the user refuses, and asks again next time", async () => {
    const h = harness({ allow: false });
    const project = h.project();
    const result = await h.handlers.run(`p:${project.id}`, serviceAction("web", "start"));
    assert.deepEqual([result.ok, result.ok ? "" : result.reason], [false, "denied"]);
    assert.equal(h.launched.length, 0);
    assert.equal(h.written.length, 0);
    assert.equal(isRunTrusted(h.db, "/work/app", "a".repeat(64)), false);
    await h.handlers.run(`p:${project.id}`, serviceAction("web", "start"));
    assert.equal(h.confirms.length, 2);
  });

  it("asks again, flagged as changed, when the manifest content changes", async () => {
    const h = harness();
    const project = h.project();
    await h.handlers.run(`p:${project.id}`, serviceAction("web", "start"));
    h.advance(61_000);
    h.setLoaded({ status: "ok", manifest: manifestOf(), hash: "c".repeat(64) });
    await h.handlers.run(`p:${project.id}`, serviceAction("web", "start"));
    assert.equal(h.confirms.length, 2);
    assert.equal(h.confirms[1]?.changed, true);
  });
});

describe("run handlers: open web", () => {
  it("refuses until a frontend is listening, then opens only that local address", async () => {
    const h = harness();
    const project = h.project();
    const early = await h.handlers.run(`p:${project.id}`, serviceAction("web", "web"));
    assert.deepEqual([early.ok, early.ok ? "" : early.reason], [false, "not-running"]);

    await h.handlers.run(`p:${project.id}`, serviceAction("web", "start"));
    const stillStarting = await h.handlers.run(`p:${project.id}`, serviceAction("web", "web"));
    assert.equal(stillStarting.ok, false);

    h.listening.add(41002);
    ok(await h.handlers.run(`p:${project.id}`, serviceAction("web", "web")));
    assert.deepEqual(h.opened, ["http://localhost:41002"]);
    assert.equal(h.launched.length, 1);
  });

  it("never asks for confirmation or starts anything", async () => {
    const h = harness();
    const project = h.project();
    await h.handlers.run(`p:${project.id}`, serviceAction("web", "web"));
    assert.equal(h.confirms.length, 0);
    assert.equal(h.launched.length, 0);
  });
});

describe("run handlers: open README", () => {
  const readmes = { "/work/app": "/work/app/README.md" };

  it("enables the button only for targets that have a README.md", async () => {
    const h = harness({ readmes, discovered: [{ label: "bare", folder: "/work/bare" }] });
    h.project("/work/app");
    const [withReadme, without] = (await h.handlers.overview()).targets;
    assert.deepEqual(withReadme?.readme, { enabled: true, reason: null });
    assert.deepEqual(without?.readme, { enabled: false, reason: "找不到 README.md" });
  });

  it("opens the README the main process found, never a path from the caller", async () => {
    const h = harness({ readmes });
    const project = h.project("/work/app");
    const result = await h.handlers.run(`p:${project.id}`, { scope: "project", action: "readme" });
    ok(result);
    assert.deepEqual(h.documents, ["/work/app/README.md"]);
    assert.ok(h.logs.some((line) => line.includes("README.md")));
  });

  it("works without a launch manifest and never touches iTerm2 or asks for confirmation", async () => {
    const h = harness({ readmes, loaded: { status: "missing" }, iterm: false });
    const project = h.project("/work/app");
    ok(await h.handlers.run(`p:${project.id}`, { scope: "project", action: "readme" }));
    assert.deepEqual(h.documents, ["/work/app/README.md"]);
    assert.equal(h.launched.length, 0);
    assert.equal(h.confirms.length, 0);
  });

  it("reports a missing README and an opener failure without opening anything extra", async () => {
    const missing = harness();
    const first = missing.project("/work/app");
    const none = await missing.handlers.run(`p:${first.id}`, { scope: "project", action: "readme" });
    assert.deepEqual(none, { ok: false, reason: "no-readme", message: "找不到 README.md" });
    assert.deepEqual(missing.documents, []);

    const broken = harness({ readmes, openDocument: { ok: false, message: "無法開啟路徑：boom" } });
    const second = broken.project("/work/app");
    const failed = await broken.handlers.run(`p:${second.id}`, { scope: "project", action: "readme" });
    assert.deepEqual(failed, { ok: false, reason: "failed", message: "無法開啟路徑：boom" });
  });

  it("rejects an unknown target", async () => {
    const h = harness({ readmes });
    const result = await h.handlers.run("p:99", { scope: "project", action: "readme" });
    assert.equal(result.ok, false);
    assert.deepEqual(h.documents, []);
  });
});

describe("run handlers: reinstall dependencies", () => {
  const reinstall: RunAction = { scope: "project", action: "reinstall" };
  const reasonOf = (result: { ok: boolean; reason?: string }): string => (result.ok ? "" : (result.reason ?? ""));
  const command = (manager: InstallManager): string => `rm -rf node_modules && ${manager} install`;

  it("enables the button only for Node projects with iTerm2 and nothing running", async () => {
    const none = harness({ discovered: [{ label: "bare", folder: "/work/bare" }] });
    none.project("/work/app");
    assert.deepEqual((await none.handlers.overview()).targets.map((target) => target.reinstall), [
      { enabled: false, reason: "沒有 package.json，不是 Node 專案" },
      { enabled: false, reason: "沒有 package.json，不是 Node 專案" }
    ]);

    const node = harness({ packages: ["/work/app"] });
    node.project("/work/app");
    assert.deepEqual((await node.handlers.overview()).targets[0]?.reinstall, { enabled: true, reason: null });

    const noIterm = harness({ packages: ["/work/app"], iterm: false });
    noIterm.project("/work/app");
    assert.deepEqual((await noIterm.handlers.overview()).targets[0]?.reinstall, { enabled: false, reason: "找不到 iTerm2" });
  });

  it("asks first, then opens one iTerm2 tab per package folder with that folder's installer", async () => {
    const h = harness({ packages: ["/work/app", "/work/app/api"], installers: { "/work/app": "pnpm" } });
    const project = h.project("/work/app");
    const result = await h.handlers.run(`p:${project.id}`, reinstall);
    ok(result);
    assert.deepEqual(h.reinstallConfirms, [
      {
        label: "app",
        folder: "/work/app",
        items: [
          { dir: ".", command: command("pnpm") },
          { dir: "api", command: command("pnpm") }
        ]
      }
    ]);
    assert.deepEqual(h.launched, [
      [
        { dir: "/work/app", name: `gitnrun p:${project.id} Reinstall`, command: command("pnpm") },
        { dir: "/work/app/api", name: `gitnrun p:${project.id} Reinstall-2`, command: command("pnpm") }
      ]
    ]);
    // 與啟動指令的信任無關：不問啟動確認、不結束任何 port。
    assert.equal(h.confirms.length, 0);
    assert.equal(h.stopped.length, 0);
    assert.ok(h.logs.some((line) => line.includes("重裝")));
  });

  it("keeps a sub folder's own installer instead of the root's", async () => {
    const h = harness({ packages: ["/work/app", "/work/app/api"], installers: { "/work/app": "pnpm", "/work/app/api": "yarn" } });
    const project = h.project("/work/app");
    ok(await h.handlers.run(`p:${project.id}`, reinstall));
    assert.deepEqual(h.launched[0]?.map((tab) => tab.command), [command("pnpm"), command("yarn")]);
  });

  it("works without a launch manifest, using only the project folder", async () => {
    const h = harness({ packages: ["/work/app"], loaded: { status: "missing" } });
    const project = h.project("/work/app");
    ok(await h.handlers.run(`p:${project.id}`, reinstall));
    assert.deepEqual(h.launched[0]?.map((tab) => tab.dir), ["/work/app"]);
  });

  it("deletes and launches nothing when the user cancels", async () => {
    const h = harness({ packages: ["/work/app"], reinstallAllow: false });
    const project = h.project("/work/app");
    const result = await h.handlers.run(`p:${project.id}`, reinstall);
    assert.deepEqual([result.ok, reasonOf(result)], [false, "denied"]);
    assert.equal(h.reinstallConfirms.length, 1);
    assert.equal(h.launched.length, 0);
  });

  it("refuses while a service is starting or running, before asking anything, and works again once it ended", async () => {
    const h = harness({ packages: ["/work/app"] });
    const project = h.project("/work/app");
    ok(await h.handlers.run(`p:${project.id}`, serviceAction("web", "start")));

    const starting = await h.handlers.run(`p:${project.id}`, reinstall);
    assert.deepEqual([starting.ok, reasonOf(starting)], [false, "running"]);
    assert.deepEqual((await h.handlers.overview()).targets[0]?.reinstall, { enabled: false, reason: "請先結束執行中的服務" });

    h.listening.add(41002);
    const running = await h.handlers.run(`p:${project.id}`, reinstall);
    assert.deepEqual([running.ok, reasonOf(running)], [false, "running"]);
    assert.equal(h.reinstallConfirms.length, 0);

    ok(await h.handlers.run(`p:${project.id}`, stopProject));
    h.launched.length = 0;
    ok(await h.handlers.run(`p:${project.id}`, reinstall));
    assert.equal(h.launched.length, 1);
  });

  it("refuses folders without a package.json, a missing iTerm2, and unknown targets", async () => {
    const bare = harness();
    const first = bare.project("/work/app");
    const noPackage = await bare.handlers.run(`p:${first.id}`, reinstall);
    assert.deepEqual([noPackage.ok, reasonOf(noPackage)], [false, "no-package"]);
    assert.equal(bare.reinstallConfirms.length, 0);

    const noIterm = harness({ packages: ["/work/app"], iterm: false });
    const second = noIterm.project("/work/app");
    const missing = await noIterm.handlers.run(`p:${second.id}`, reinstall);
    assert.deepEqual([missing.ok, reasonOf(missing)], [false, "iterm-missing"]);
    assert.equal(noIterm.reinstallConfirms.length, 0);

    const unknown = await bare.handlers.run("p:99", reinstall);
    assert.equal(unknown.ok, false);
  });

  it("maps a denied macOS automation permission and other launch errors", async () => {
    const denied = harness({ packages: ["/work/app"], launch: { code: 1, stderr: "execution error: Not authorized to send Apple events (-1743)" } });
    const first = denied.project("/work/app");
    assert.equal(reasonOf(await denied.handlers.run(`p:${first.id}`, reinstall)), "permission-denied");

    const broken = harness({ packages: ["/work/app"], launch: { code: 1, stderr: "boom" } });
    const second = broken.project("/work/app");
    const failed = await broken.handlers.run(`p:${second.id}`, reinstall);
    assert.deepEqual(failed, { ok: false, reason: "failed", message: "無法在 iTerm2 開啟：boom" });
  });
});

describe("run handlers: release terminal ports", () => {
  const swept = { ended: [{ pid: 9, command: "node", ports: [41002] }], failed: [{ pid: 10, command: "python", ports: [8000] }] };

  it("lists what would be ended without ending anything", async () => {
    const h = harness({ sweep: swept });
    const scan = await h.handlers.scanPorts();
    assert.deepEqual(scan.targets.map((target) => target.pid), [9, 10]);
    assert.deepEqual(h.sweepCalls, ["scan"]);
  });

  it("forgets the services whose port was released, and keeps the others", async () => {
    const h = harness({ sweep: swept });
    const project = h.project();
    ok(await h.handlers.run(`p:${project.id}`, serviceAction("web", "start")));
    h.listening.add(41002);
    const stateOf = async (name: string): Promise<string | undefined> =>
      (await h.handlers.overview()).targets[0]?.services.find((service) => service.name === name)?.state;
    assert.equal(await stateOf("web"), "running");

    // 結束程序後 port 空了；沒清記錄的話，卡片會在寬限時間內一直停在「啟動中」。
    h.listening.delete(41002);
    assert.equal(await stateOf("web"), "starting");
    const result = await h.handlers.releasePorts();
    assert.deepEqual(result, swept);
    assert.deepEqual(h.sweepCalls, ["release"]);
    assert.equal(await stateOf("web"), "stopped");
    assert.equal(await stateOf("api"), "starting");
  });

  it("logs what it released and what it could not", async () => {
    const h = harness({ sweep: swept });
    await h.handlers.releasePorts();
    assert.ok(h.logs.some((line) => line.includes("已釋放終端機 port") && line.includes("node(41002)")));
    assert.ok(h.logs.some((line) => line.includes("無法結束") && line.includes("python(8000)")));
  });

  it("changes nothing when no terminal port is open", async () => {
    const h = harness();
    assert.deepEqual(await h.handlers.releasePorts(), { ended: [], failed: [] });
    assert.deepEqual(h.logs, []);
  });
});

describe("run handlers: dev account and passcode", () => {
  const PASSCODE = "dev-passcode-0042";

  it("shows an empty account and an unbound passcode source for every target, even without a manifest", async () => {
    const h = harness({ loaded: { status: "missing" } });
    const project = h.project();
    const overview = await h.handlers.overview();
    const [target] = overview.targets;
    assert.equal(target?.manifest, "missing");
    assert.equal(target?.account, "");
    assert.deepEqual(target?.passcodeSource, { binding: null, state: "unbound", hint: "", candidates: [] });
    assert.deepEqual(target?.legacyPasscode, { name: `devpass.p${project.id}`, configured: false, state: "missing", hint: "", updatedAt: null });
  });

  it("stores the account trimmed, and clears it with an empty string", async () => {
    const h = harness();
    const project = h.project();
    const id = `p:${project.id}`;
    h.handlers.setAccount(id, "  tester@example.com  ");
    assert.equal((await h.handlers.overview()).targets[0]?.account, "tester@example.com");
    h.handlers.setAccount(id, "");
    assert.equal((await h.handlers.overview()).targets[0]?.account, "");
    assert.equal(getRunAccount(h.db, id), "");
  });

  it("keeps each target's account separate", async () => {
    const h = harness();
    const first = h.project("/work/app");
    await h.handlers.addFolder("/work/extra");
    h.handlers.setAccount(`p:${first.id}`, "alice");
    h.handlers.setAccount("f:1", "bob");
    const accounts = (await h.handlers.overview()).targets.map((target) => [target.id, target.account]);
    assert.deepEqual(accounts, [[`p:${first.id}`, "alice"], ["f:1", "bob"]]);
  });

  it("rejects accounts for unknown targets and malformed accounts", async () => {
    const h = harness();
    const project = h.project();
    assert.throws(() => h.handlers.setAccount("p:999", "alice"), UserFacingError);
    assert.throws(() => h.handlers.setAccount(`p:${project.id}`, "x".repeat(201)), UserFacingError);
    assert.throws(() => h.handlers.setAccount(`p:${project.id}`, "a\nb"), UserFacingError);
  });

  const BLOOM = { file: ".dev.vars", key: "DEBUG_AUTH_PASSWORD" } as const;

  it("copies the password from the bound environment file, never from the vault, and keeps it out of the overview and logs", async () => {
    const h = harness({ passcodeFiles: { "/work/app::.dev.vars": `# local\nDEBUG_AUTH_PASSWORD="${PASSCODE}"\n` } });
    const project = h.project();
    const id = `p:${project.id}`;
    h.vault.set(`devpass.p${project.id}`, "old-vault-secret-0001");
    h.handlers.bindPasscode(id, BLOOM);
    await h.handlers.copyPasscode(id);
    assert.deepEqual(h.copied, [PASSCODE]);

    const overview = await h.handlers.overview();
    assert.deepEqual(overview.targets[0]?.passcodeSource, { binding: BLOOM, state: "ok", hint: "0042", candidates: [] });
    assert.equal(overview.targets[0]?.legacyPasscode.configured, true);
    assert.equal(JSON.stringify(overview).includes(PASSCODE), false);
    assert.equal(h.logs.join(" ").includes(PASSCODE), false);
  });

  it("reads the environment file again on every copy", async () => {
    const h = harness({ passcodeFiles: { "/work/app::.dev.vars": "DEBUG_AUTH_PASSWORD=first-password-0001\n" } });
    const id = `p:${h.project().id}`;
    h.handlers.bindPasscode(id, BLOOM);
    await h.handlers.copyPasscode(id);
    h.passcodeFiles.set("/work/app::.dev.vars", "DEBUG_AUTH_PASSWORD=second-password-0002\n");
    await h.handlers.copyPasscode(id);
    assert.deepEqual(h.copied, ["first-password-0001", "second-password-0002"]);
  });

  it("explains why a password cannot be copied and never falls back to the vault", async () => {
    const h = harness();
    const project = h.project();
    const id = `p:${project.id}`;
    h.vault.set(`devpass.p${project.id}`, "old-vault-secret-0001");

    await assert.rejects(h.handlers.copyPasscode(id), (error: Error) => error instanceof UserFacingError && error.message === passcodeProblem("unbound", null));
    await assert.rejects(h.handlers.copyPasscode("p:999"), UserFacingError);

    h.handlers.bindPasscode(id, BLOOM);
    const cases: Array<[string | null, "no-file" | "no-key" | "empty"]> = [
      [null, "no-file"],
      ["OTHER_KEY=1\n", "no-key"],
      ["DEBUG_AUTH_PASSWORD=\n", "empty"]
    ];
    for (const [text, state] of cases) {
      if (text === null) h.passcodeFiles.delete("/work/app::.dev.vars");
      else h.passcodeFiles.set("/work/app::.dev.vars", text);
      await assert.rejects(h.handlers.copyPasscode(id), (error: Error) => error instanceof UserFacingError && error.message === passcodeProblem(state, BLOOM));
      assert.equal((await h.handlers.overview()).targets[0]?.passcodeSource.state, state);
    }
    assert.deepEqual(h.copied, []);
  });

  it("binds, validates and unbinds the password source", async () => {
    const h = harness();
    const project = h.project();
    const id = `p:${project.id}`;
    h.handlers.bindPasscode(id, { file: "apps/edge/.dev.vars", key: "DEBUG_PASSWORD" });
    assert.deepEqual(getPasscodeBinding(h.db, id), { file: "apps/edge/.dev.vars", key: "DEBUG_PASSWORD" });
    // 檔案還不存在也可以先綁定。
    assert.equal((await h.handlers.overview()).targets[0]?.passcodeSource.state, "no-file");

    for (const bad of [
      { file: "/etc/passwd", key: "DEBUG_PASSWORD" },
      { file: "../.env", key: "DEBUG_PASSWORD" },
      { file: "notes.txt", key: "DEBUG_PASSWORD" },
      { file: ".env", key: "debug_password" },
      { file: ".env", key: "VITE_DEBUG_PASSWORD" }
    ]) {
      assert.throws(() => h.handlers.bindPasscode(id, bad), UserFacingError, JSON.stringify(bad));
    }
    assert.throws(() => h.handlers.bindPasscode("p:999", BLOOM), UserFacingError);
    assert.deepEqual(getPasscodeBinding(h.db, id), { file: "apps/edge/.dev.vars", key: "DEBUG_PASSWORD" });

    h.handlers.unbindPasscode(id);
    assert.equal(getPasscodeBinding(h.db, id), null);
    assert.equal((await h.handlers.overview()).targets[0]?.passcodeSource.state, "unbound");
    assert.throws(() => h.handlers.unbindPasscode("p:999"), UserFacingError);
  });

  it("opens only the bound environment file that the main process located", async () => {
    const h = harness({ passcodeFiles: { "/work/app::.dev.vars": "DEBUG_AUTH_PASSWORD=x\n" } });
    const id = `p:${h.project().id}`;
    await assert.rejects(h.handlers.openPasscodeFile(id), UserFacingError);
    h.handlers.bindPasscode(id, BLOOM);
    await h.handlers.openPasscodeFile(id);
    assert.deepEqual(h.documents, ["/work/app/.dev.vars"]);

    h.passcodeFiles.clear();
    await assert.rejects(h.handlers.openPasscodeFile(id), UserFacingError);
    await assert.rejects(h.handlers.openPasscodeFile("p:999"), UserFacingError);
    assert.deepEqual(h.documents, ["/work/app/.dev.vars"]);
  });

  it("lists several candidates for the user to choose, and reuses the scan for a while", async () => {
    const suggestions: PasscodeBinding[] = [{ file: ".env", key: "DEBUG_PASSWORD" }, { file: "apps/edge/.dev.vars", key: "DEBUG_AUTH_PASSWORD" }];
    const h = harness({ candidates: { "/work/app": suggestions } });
    const id = `p:${h.project().id}`;

    assert.deepEqual((await h.handlers.overview()).targets[0]?.passcodeSource.candidates, suggestions);
    assert.equal(getPasscodeBinding(h.db, id), null);
    await h.handlers.overview();
    assert.equal(h.scans.length, 1);

    h.advance(31_000);
    await h.handlers.overview();
    assert.equal(h.scans.length, 2);

    h.handlers.bindPasscode(id, suggestions[0] as PasscodeBinding);
    assert.deepEqual((await h.handlers.overview()).targets[0]?.passcodeSource.candidates, []);
    assert.equal(h.scans.length, 2);
  });

  it("scans every target the same way, whatever the framework or manifest", async () => {
    const found: PasscodeBinding = { file: ".env", key: "DEBUG_PASSWORD" };
    const noFramework = harness({ candidates: { "/work/app": [found] }, passcodeFiles: { "/work/app::.env": "DEBUG_PASSWORD=plain-0001\n" } });
    noFramework.project();
    assert.equal((await noFramework.handlers.overview()).targets[0]?.passcodeSource.state, "ok");
    assert.equal(noFramework.scans.length, 1);

    const noManifest = harness({ loaded: { status: "missing" }, candidates: { "/work/app": [found] }, passcodeFiles: { "/work/app::.env": "DEBUG_PASSWORD=plain-0002\n" } });
    noManifest.project();
    assert.equal((await noManifest.handlers.overview()).targets[0]?.passcodeSource.state, "ok");
  });

  it("binds a single candidate automatically, and only keeps it until the user releases it", async () => {
    const found: PasscodeBinding = { file: ".env", key: "DEBUG_PASSWORD" };
    const h = harness({ candidates: { "/work/app": [found] }, passcodeFiles: { "/work/app::.env": "DEBUG_PASSWORD=auto-pass-0042\n" } });
    const id = `p:${h.project().id}`;

    assert.deepEqual((await h.handlers.overview()).targets[0]?.passcodeSource, { binding: found, state: "ok", hint: "0042", candidates: [] });
    assert.deepEqual(getPasscodeBinding(h.db, id), found);
    await h.handlers.copyPasscode(id);
    assert.deepEqual(h.copied, ["auto-pass-0042"]);

    h.handlers.unbindPasscode(id);
    await h.handlers.recheckPasscode(id);
    const released = (await h.handlers.overview()).targets[0]?.passcodeSource;
    assert.deepEqual(released, { binding: null, state: "unbound", hint: "", candidates: [found] });
    assert.equal(getPasscodeBinding(h.db, id), null);

    // 手動指定後再解除前不受影響；再次手動綁定會解除封鎖。
    h.handlers.bindPasscode(id, found);
    assert.deepEqual(getPasscodeBinding(h.db, id), found);
  });

  it("does not let one target's release stop another from being bound automatically", async () => {
    const found: PasscodeBinding = { file: ".env", key: "DEBUG_PASSWORD" };
    const h = harness({
      candidates: { "/work/a": [found], "/work/b": [found] },
      passcodeFiles: { "/work/a::.env": "DEBUG_PASSWORD=aaaa-0001\n", "/work/b::.env": "DEBUG_PASSWORD=bbbb-0002\n" }
    });
    const a = h.project("/work/a");
    h.handlers.unbindPasscode(`p:${a.id}`);
    const b = h.project("/work/b");
    await h.handlers.overview();
    assert.equal(getPasscodeBinding(h.db, `p:${a.id}`), null);
    assert.deepEqual(getPasscodeBinding(h.db, `p:${b.id}`), found);
  });

  it("recheck makes the next overview scan again instead of using the cache", async () => {
    const h = harness({ candidates: { "/work/app": [] } });
    const id = `p:${h.project().id}`;
    await h.handlers.overview();
    await h.handlers.overview();
    assert.equal(h.scans.length, 1);
    h.handlers.recheckPasscode(id);
    await h.handlers.overview();
    assert.equal(h.scans.length, 2);
    assert.throws(() => h.handlers.recheckPasscode("p:999"), UserFacingError);
  });

  it("detects the formerly hard-coded projects without any folder-name rule", async () => {
    const h = harness({
      candidates: { "/work/toBloom": [BLOOM], "/work/stockPaw": [{ file: ".env", key: "DEBUG_PASSWORD" }] },
      passcodeFiles: {
        "/work/toBloom::.dev.vars": "DEBUG_AUTH_PASSWORD=bloom-password-0042\n",
        "/work/stockPaw::.env": "DEBUG_PASSWORD=paw-password-0007\n"
      }
    });
    const bloom = h.project("/work/toBloom");
    const paw = h.project("/work/stockPaw");
    await h.handlers.overview();
    assert.deepEqual(getPasscodeBinding(h.db, `p:${bloom.id}`), BLOOM);
    assert.deepEqual(getPasscodeBinding(h.db, `p:${paw.id}`), { file: ".env", key: "DEBUG_PASSWORD" });
  });

  it("keeps copying from an environment file when the vault is unavailable", async () => {
    const h = harness({ passcodeFiles: { "/work/app::.dev.vars": "DEBUG_AUTH_PASSWORD=env-password-0042\n" } });
    const project = h.project();
    h.cipher.available = false;
    h.handlers.bindPasscode(`p:${project.id}`, BLOOM);
    await h.handlers.copyPasscode(`p:${project.id}`);
    assert.deepEqual(h.copied, ["env-password-0042"]);
    h.handlers.setAccount(`p:${project.id}`, "alice");
    assert.equal((await h.handlers.overview()).targets[0]?.account, "alice");
  });

  it("clears a leftover vault password only through the existing secret deletion", async () => {
    const h = harness();
    const project = h.project();
    h.vault.set(`devpass.p${project.id}`, "old-vault-secret-0001");
    assert.equal((await h.handlers.overview()).targets[0]?.legacyPasscode.configured, true);
    h.vault.delete(`devpass.p${project.id}`);
    assert.equal((await h.handlers.overview()).targets[0]?.legacyPasscode.configured, false);
  });

  it("removes the account and passcode together with an added folder, so a reused id starts empty", async () => {
    const h = harness();
    await h.handlers.addFolder("/work/extra");
    h.handlers.setAccount("f:1", "bob");
    h.handlers.bindPasscode("f:1", BLOOM);
    h.vault.set("devpass.f1", PASSCODE);
    h.handlers.removeFolder("f:1");
    assert.equal(getRunAccount(h.db, "f:1"), "");
    assert.equal(getPasscodeBinding(h.db, "f:1"), null);
    assert.equal(h.vault.has("devpass.f1"), false);

    await h.handlers.addFolder("/work/another");
    const [target] = (await h.handlers.overview()).targets;
    assert.equal(target?.id, "f:1");
    assert.equal(target?.account, "");
    assert.equal(target?.legacyPasscode.configured, false);
    assert.equal(target?.passcodeSource.state, "unbound");
  });
});

describe("passcode source: environment files", () => {
  const withDir = async (work: (root: string) => Promise<void>): Promise<void> => {
    const root = mkdtempSync(join(tmpdir(), "gitnrun-passcode-"));
    try {
      await work(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it("validates file names and keys", () => {
    for (const file of [".env", ".env.local", ".env.development", ".env.development.local", ".dev.vars", "apps/edge/.dev.vars", "a/b/c/d/.env"]) {
      assert.equal(isPasscodeFile(file), true, file);
    }
    for (const file of ["", "/abs/.env", "../.env", "a/../.env", "a//.env", "./.env", "notes.txt", ".env.production", "a\\.env", ".env\n", "a/b/c/d/e/.env", `${"a/".repeat(120)}.env`, 42, null]) {
      assert.equal(isPasscodeFile(file), false, String(file));
    }
    for (const key of ["DEBUG_PASSWORD", "DEBUG_AUTH_PASSWORD", "_X1"]) assert.equal(isPasscodeKey(key), true, key);
    for (const key of ["", "debug_password", "1ABC", "A-B", "A".repeat(65), "NEXT_PUBLIC_DEBUG_PASSWORD", "VITE_DEBUG_PASSWORD", "NUXT_PUBLIC_X", "PUBLIC_X", "EXPO_PUBLIC_X", 7]) {
      assert.equal(isPasscodeKey(key), false, String(key));
    }
    assert.deepEqual(normalizePasscodeBinding({ file: ".env", key: "DEBUG_PASSWORD", extra: 1 }), { file: ".env", key: "DEBUG_PASSWORD" });
    assert.equal(normalizePasscodeBinding({ file: ".env" }), null);
    assert.equal(normalizePasscodeBinding(null), null);
    assert.equal(normalizePasscodeBinding([".env", "DEBUG_PASSWORD"]), null);
  });

  it("parses dotenv text: export, quotes, trailing comments, empty values, duplicates and comment lines", () => {
    const entries = parseEnvText(
      [
        "# DEBUG_PASSWORD=from-comment",
        "export A=exported",
        'B="double quoted # not a comment"',
        "C='single quoted'",
        "D=plain # trailing comment",
        "E=",
        "F=first",
        "F=last",
        "G=with#hash",
        "  H = spaced  ",
        "not a pair",
        "CRLF=line\r"
      ].join("\r\n")
    );
    assert.equal(entries.get("DEBUG_PASSWORD"), undefined);
    assert.equal(entries.get("A"), "exported");
    assert.equal(entries.get("B"), "double quoted # not a comment");
    assert.equal(entries.get("C"), "single quoted");
    assert.equal(entries.get("D"), "plain");
    assert.equal(entries.get("E"), "");
    assert.equal(entries.get("F"), "last");
    assert.equal(entries.get("G"), "with#hash");
    assert.equal(entries.get("H"), "spaced");
    assert.equal(interpretEnvText("E=\n", "E").state, "empty");
    assert.equal(interpretEnvText("A=1\n", "B").state, "no-key");
    assert.deepEqual(interpretEnvText("A=1\n", "A"), { state: "ok", value: "1" });
  });

  it("reads a bound key and reports a missing file, key or value", async () => {
    await withDir(async (root) => {
      mkdirSync(join(root, "apps/edge"), { recursive: true });
      writeFileSync(join(root, ".env"), "DEBUG_PASSWORD='paw-test-password'\nEMPTY=\n");
      writeFileSync(join(root, "apps/edge/.dev.vars"), "DEBUG_AUTH_PASSWORD=edge-password\n");
      assert.deepEqual(await fsPasscodeSource.read(root, { file: ".env", key: "DEBUG_PASSWORD" }), { state: "ok", value: "paw-test-password" });
      assert.deepEqual(await fsPasscodeSource.read(root, { file: "apps/edge/.dev.vars", key: "DEBUG_AUTH_PASSWORD" }), { state: "ok", value: "edge-password" });
      assert.equal((await fsPasscodeSource.read(root, { file: ".env", key: "EMPTY" })).state, "empty");
      assert.equal((await fsPasscodeSource.read(root, { file: ".env", key: "MISSING" })).state, "no-key");
      assert.equal((await fsPasscodeSource.read(root, { file: ".env.local", key: "DEBUG_PASSWORD" })).state, "no-file");
      assert.equal((await fsPasscodeSource.read(join(root, "nope"), { file: ".env", key: "DEBUG_PASSWORD" })).state, "no-file");
      assert.equal(await fsPasscodeSource.locate(root, { file: ".env.local", key: "X" }), null);
      assert.ok((await fsPasscodeSource.locate(root, { file: ".env", key: "X" }))?.endsWith("/.env"));
    });
  });

  it("refuses files that are not safe to read", async () => {
    await withDir(async (root) => {
      const project = join(root, "project");
      mkdirSync(join(project, "dir"), { recursive: true });
      mkdirSync(join(project, ".env.local"));
      writeFileSync(join(root, "outside.txt"), "DEBUG_PASSWORD=outside-secret\n");
      symlinkSync(join(root, "outside.txt"), join(project, ".env"));
      writeFileSync(join(project, ".dev.vars"), `DEBUG_PASSWORD=${"x".repeat(70 * 1024)}\n`);
      writeFileSync(join(project, "inside.txt"), "DEBUG_PASSWORD=inside\n");
      symlinkSync(join(project, "inside.txt"), join(project, "dir/.env"));

      const binding = (file: string): PasscodeBinding => ({ file, key: "DEBUG_PASSWORD" });
      assert.deepEqual(await fsPasscodeSource.read(project, binding(".env")), { state: "unsafe", value: null });
      assert.deepEqual(await fsPasscodeSource.read(project, binding(".env.local")), { state: "unsafe", value: null });
      assert.deepEqual(await fsPasscodeSource.read(project, binding(".dev.vars")), { state: "unsafe", value: null });
      assert.deepEqual(await fsPasscodeSource.read(project, binding("notes.txt")), { state: "unsafe", value: null });
      assert.equal(await fsPasscodeSource.locate(project, binding(".env")), null);
      // 連結指到專案內的檔案是可以的，但檔名仍要在白名單內，真實檔名不影響。
      assert.deepEqual(await fsPasscodeSource.read(project, binding("dir/.env")), { state: "ok", value: "inside" });
    });
  });

  it("picks debug password keys only", () => {
    for (const key of ["DEBUG_AUTH_PASSWORD", "DEBUG_PASSWORD", "DEV_PASSWORD", "LOCAL_ADMIN_PWD", "APP_DEBUG_PASSCODE"]) {
      assert.equal(isPasscodeCandidateKey(key), true, key);
    }
    for (const key of ["DATABASE_PASSWORD", "API_KEY", "DEBUG_USERNAME", "DEBUG", "PASSWORD", "NEXT_PUBLIC_DEBUG_PASSWORD", "DEVICE_PASSWORD"]) {
      assert.equal(isPasscodeCandidateKey(key), false, key);
    }
  });

  it("finds candidates in the root, service folders and workspace folders", async () => {
    await withDir(async (root) => {
      // Worker：.dev.vars 在根目錄。
      const worker = join(root, "worker");
      mkdirSync(worker);
      writeFileSync(join(worker, ".dev.vars"), "APP_JWT_SECRET=x\nDEBUG_AUTH_PASSWORD=\n");
      assert.deepEqual(await fsPasscodeSource.scan(worker, { serviceDirs: [worker] }), [{ file: ".dev.vars", key: "DEBUG_AUTH_PASSWORD" }]);

      // Django：根目錄 .env；DATABASE_PASSWORD 不是候選。
      const django = join(root, "django");
      mkdirSync(django);
      writeFileSync(join(django, ".env"), "DATABASE_PASSWORD=db\nDEBUG_PASSWORD=dev\n");
      assert.deepEqual(await fsPasscodeSource.scan(django, { serviceDirs: [django] }), [{ file: ".env", key: "DEBUG_PASSWORD" }]);

      // 多服務：根目錄 .env 與 apps/edge/.dev.vars 都列出，服務目錄不重複。
      const multi = join(root, "multi");
      mkdirSync(join(multi, "apps/edge"), { recursive: true });
      mkdirSync(join(multi, "apps/api"), { recursive: true });
      writeFileSync(join(multi, ".env"), "DEBUG_PASSWORD=root\n");
      writeFileSync(join(multi, "apps/edge/.dev.vars"), "DEBUG_AUTH_PASSWORD=edge\n");
      writeFileSync(join(multi, "apps/api/.env"), "DEV_PASSWORD=api\n");
      const found = await fsPasscodeSource.scan(multi, { serviceDirs: [join(multi, "apps/api"), join(multi, "apps/api")] });
      assert.deepEqual(
        found.map((candidate) => `${candidate.file}:${candidate.key}`).sort(),
        ["apps/api/.env:DEV_PASSWORD", "apps/edge/.dev.vars:DEBUG_AUTH_PASSWORD", ".env:DEBUG_PASSWORD"].sort()
      );

      // 公開前綴與建置輸出都不會被建議。
      const web = join(root, "web");
      mkdirSync(join(web, "dist"), { recursive: true });
      writeFileSync(join(web, ".env.local"), "NEXT_PUBLIC_DEBUG_PASSWORD=public\n");
      writeFileSync(join(web, "dist/.dev.vars"), "DEBUG_AUTH_PASSWORD=build-copy\n");
      assert.deepEqual(await fsPasscodeSource.scan(web, { serviceDirs: [web] }), []);
      // 服務工作目錄跳出專案資料夾時忽略。
      assert.deepEqual(await fsPasscodeSource.scan(django, { serviceDirs: [worker] }), [{ file: ".env", key: "DEBUG_PASSWORD" }]);
    });
  });

  it("ignores corrupted bindings in the settings table", () => {
    const db = createTestDb();
    setSetting(db, "run.passcodeSources", {
      "p:1": { file: ".env", key: "DEBUG_PASSWORD" },
      "p:2": { file: "../.env", key: "DEBUG_PASSWORD" },
      "p:3": { file: ".env", key: "lowercase" },
      "x:4": { file: ".env", key: "DEBUG_PASSWORD" },
      "p:5": "oops"
    });
    assert.deepEqual(getPasscodeBinding(db, "p:1"), { file: ".env", key: "DEBUG_PASSWORD" });
    for (const id of ["p:2", "p:3", "x:4", "p:5", "p:6"]) assert.equal(getPasscodeBinding(db, id), null, id);
    setPasscodeBinding(db, "p:7", { file: ".dev.vars", key: "DEBUG_AUTH_PASSWORD" });
    setPasscodeBinding(db, "p:1", null);
    assert.equal(getPasscodeBinding(db, "p:1"), null);
    assert.deepEqual(getPasscodeBinding(db, "p:7"), { file: ".dev.vars", key: "DEBUG_AUTH_PASSWORD" });
  });
});

describe("run handlers: stale desktop processes", () => {
  const desktopManifest = (): LoadedManifest => {
    const result = validateManifest({ version: 1, services: [{ name: "desk", role: "desktop", command: ["pnpm", "dev"], port: false, env: {} }] });
    assert.ok(result.ok);
    return { status: "ok", manifest: result.manifest, hash: "b".repeat(64) };
  };
  const stale = (pid: number): StaleProcess => ({ pid, ppid: 1, elapsed: "19:20", command: "/work/app/node_modules/electron" });
  const make = (extra: { earlyExitCheckMs?: number } = {}) => {
    const h = harness({ loaded: desktopManifest() }, extra);
    const project = h.project();
    return { h, targetId: `p:${project.id}` };
  };

  it("asks before starting when a stale process is left, ends it, then starts", async () => {
    const { h, targetId } = make();
    h.staleState.list = [stale(7), stale(8)];
    ok(await h.handlers.run(targetId, serviceAction("desk", "start")));
    assert.equal(h.staleState.confirms, 1);
    assert.deepEqual(h.staleState.ended, [[7, 8]]);
    assert.equal(h.launched.length, 1);
  });

  it("does not start or kill anything when the stale-process prompt is refused", async () => {
    const { h, targetId } = make();
    h.staleState.list = [stale(7)];
    h.staleState.allow = false;
    const result = await h.handlers.run(targetId, serviceAction("desk", "start"));
    assert.deepEqual([result.ok, result.ok ? "" : result.reason], [false, "denied"]);
    assert.equal(h.launched.length, 0);
    assert.deepEqual(h.staleState.ended, []);
  });

  it("does not start when a stale process cannot be ended", async () => {
    const { h, targetId } = make();
    h.staleState.list = [stale(7)];
    h.staleState.failEnd = true;
    const result = await h.handlers.run(targetId, serviceAction("desk", "start"));
    assert.deepEqual([result.ok, result.ok ? "" : result.reason], [false, "failed"]);
    assert.equal(h.launched.length, 0);
  });

  it("does not prompt when nothing is left over", async () => {
    const { h, targetId } = make();
    ok(await h.handlers.run(targetId, serviceAction("desk", "start")));
    assert.equal(h.staleState.confirms, 0);
  });

  it("stop also cleans processes that no session knows about", async () => {
    const { h, targetId } = make();
    h.staleState.list = [stale(9)];
    const result = await h.handlers.run(targetId, serviceAction("desk", "stop"));
    ok(result);
    assert.deepEqual(h.staleState.ended, [[9]]);
    const empty = await h.handlers.run(targetId, serviceAction("desk", "stop"));
    assert.deepEqual([empty.ok, empty.ok ? "" : empty.reason], [false, "nothing-to-do"]);
  });

  it("flags a desktop service whose processes are gone shortly after start", async () => {
    const { h, targetId } = make({ earlyExitCheckMs: 5 });
    ok(await h.handlers.run(targetId, serviceAction("desk", "start")));
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    const view = (await h.handlers.overview()).targets[0]?.services[0];
    assert.equal(view?.exitedEarly, true);

    ok(await h.handlers.run(targetId, serviceAction("desk", "stop")));
    assert.equal((await h.handlers.overview()).targets[0]?.services[0]?.exitedEarly, undefined);
  });

  it("does not flag a desktop service whose processes are still alive", async () => {
    const { h, targetId } = make({ earlyExitCheckMs: 5 });
    ok(await h.handlers.run(targetId, serviceAction("desk", "start")));
    h.staleState.list = [stale(7)];
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    assert.equal((await h.handlers.overview()).targets[0]?.services[0]?.exitedEarly, undefined);
  });
});

describe("run handlers: release ports", () => {
  const fixedLoaded = (): LoadedManifest => ({ status: "ok", manifest: fixedManifestOf(), hash: "c".repeat(64) });

  it("releases a port recorded in .dev/ports.json even though no session remembers it", async () => {
    const h = harness({ portsFiles: { "/work/app": { api: 41555 } } });
    const project = h.project();
    h.listening.add(41555);
    const result = await h.handlers.run(`p:${project.id}`, serviceAction("api", "release"));
    ok(result);
    assert.deepEqual(h.stopped, [[41555]]);
    assert.equal(h.listening.has(41555), false);
    assert.deepEqual(h.staleState.releases, [{ service: "api", ports: [41555] }]);
    assert.match(result.ok ? result.message : "", /41555/);
  });

  it("includes the fixed port from the manifest", async () => {
    const h = harness({ loaded: fixedLoaded() });
    const project = h.project();
    h.listening.add(5174);
    ok(await h.handlers.run(`p:${project.id}`, serviceAction("api", "release")));
    assert.deepEqual(h.stopped, [[5174]]);
  });

  it("only touches the chosen service", async () => {
    const h = harness({ portsFiles: { "/work/app": { api: 41555, web: 41556 } } });
    const project = h.project();
    h.listening.add(41555);
    h.listening.add(41556);
    ok(await h.handlers.run(`p:${project.id}`, serviceAction("api", "release")));
    assert.deepEqual(h.stopped, [[41555]]);
    assert.equal(h.listening.has(41556), true);
  });

  it("ends nothing when the confirmation is cancelled", async () => {
    const h = harness({ portsFiles: { "/work/app": { api: 41555 } } });
    const project = h.project();
    h.listening.add(41555);
    h.staleState.allow = false;
    const result = await h.handlers.run(`p:${project.id}`, serviceAction("api", "release"));
    assert.deepEqual([result.ok, result.ok ? "" : result.reason], [false, "denied"]);
    assert.deepEqual(h.stopped, []);
    assert.equal(h.listening.has(41555), true);
  });

  it("reports the port that stays busy", async () => {
    const h = harness({ portsFiles: { "/work/app": { api: 41555 } } });
    const project = h.project();
    h.listening.add(41555);
    h.state.release = "never";
    const result = await h.handlers.run(`p:${project.id}`, serviceAction("api", "release"));
    assert.deepEqual([result.ok, result.ok ? "" : result.reason], [false, "failed"]);
    assert.match(result.ok ? "" : result.message, /41555/);
  });

  it("says so when there is nothing to release, and rejects unknown services", async () => {
    const h = harness();
    const project = h.project();
    const none = await h.handlers.run(`p:${project.id}`, serviceAction("api", "release"));
    assert.deepEqual([none.ok, none.ok ? "" : none.reason], [false, "nothing-to-do"]);
    const unknown = await h.handlers.run(`p:${project.id}`, serviceAction("ghost", "release"));
    assert.deepEqual([unknown.ok, unknown.ok ? "" : unknown.reason], [false, "unknown-service"]);
  });

  it("closes the tab and forgets the session after a start", async () => {
    const h = harness();
    const project = h.project();
    ok(await h.handlers.run(`p:${project.id}`, serviceAction("api", "start")));
    h.listening.add(41001);
    ok(await h.handlers.run(`p:${project.id}`, serviceAction("api", "release")));
    assert.deepEqual(h.closed.at(-1), ["gitnrun p:1 api"]);
    const view = (await h.handlers.overview()).targets[0]?.services.find((item) => item.name === "api");
    assert.equal(view?.state, "stopped");
  });

  it("hints at the release button when a fixed port is already taken", async () => {
    const h = harness({ loaded: fixedLoaded() });
    const project = h.project();
    h.listening.add(5174);
    const result = await h.handlers.run(`p:${project.id}`, serviceAction("api", "start"));
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.message, /釋放 port/);
    assert.deepEqual(h.stopped, []);
  });

  it("only enables the release button when there is something to release", async () => {
    const empty = harness();
    empty.project();
    const buttonOf = async (h: typeof empty, name: string) => (await h.handlers.overview()).targets[0]?.services.find((item) => item.name === name)?.buttons.release;
    assert.deepEqual(await buttonOf(empty, "api"), { enabled: false, reason: "沒有需要釋放的 port" });

    const recorded = harness({ portsFiles: { "/work/app": { api: 41555 } } });
    recorded.project();
    assert.equal((await buttonOf(recorded, "api"))?.enabled, true);

    const fixed = harness({ loaded: fixedLoaded() });
    fixed.project();
    assert.equal((await buttonOf(fixed, "api"))?.enabled, true);
    assert.equal((await buttonOf(fixed, "web"))?.enabled, false);
  });
});

describe("run feature stays free of AI services", () => {
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
    });

  it("does not import the AI modules or read AI keys", () => {
    const files = [...sources(join(process.cwd(), "src/main/run")), join(process.cwd(), "src/shared/run.ts"), join(process.cwd(), "src/renderer/RunView.tsx")];
    assert.ok(files.length >= 6);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      assert.equal(/@main\/ai|@shared\/ai|\/ai\/|anthropic|openai|aiEnabled/i.test(text), false, file);
    }
  });
});
