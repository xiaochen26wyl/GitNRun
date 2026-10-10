import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { validateManifest, type RunManifest } from "@shared/run";
import { addProject } from "@main/db/projects-repo";
import { UserFacingError } from "@main/errors";
import type { ItermTab } from "@main/launcher/osascript";
import { createRunHandlers, type ConfirmCommandsRequest } from "@main/run/handlers";
import type { LoadedManifest } from "@main/run/manifest";
import { getRunAccount, isRunTrusted } from "@main/run/store";
import { createVault } from "@main/vault/vault";
import { createTestDb } from "./helpers/db";
import { createFakeCipher } from "./helpers/fake-cipher";

const manifestOf = (): RunManifest => {
  const result = validateManifest({
    version: 1,
    services: [
      { name: "api", role: "backend", cwd: "api", command: ["pnpm", "dev"], port: true, env: { DEV_PORT: "{port}", FRONT: "{web.url}" } },
      { name: "web", role: "frontend", command: ["pnpm", "dev"], port: true, env: { PORT: "{port}", API: "{api.url}" } },
      { name: "panel", role: "desktop", command: ["pnpm", "dev:desktop"], needs: ["api"], port: true, env: { PORT: "{port}", API: "{api.url}" } }
    ]
  });
  assert.ok(result.ok);
  return result.manifest;
};

const harness = (options: { loaded?: LoadedManifest; iterm?: boolean; allow?: boolean; launch?: { code: number; stderr: string } } = {}) => {
  const db = createTestDb();
  const listening = new Set<number>();
  const launched: ItermTab[][] = [];
  const opened: string[] = [];
  const confirms: ConfirmCommandsRequest[] = [];
  const written: Array<{ folder: string; services: Record<string, { port: number; role: string }> }> = [];
  const logs: string[] = [];
  const copied: string[] = [];
  const cipher = createFakeCipher();
  const vault = createVault(db, cipher);
  let next = 41000;
  let time = 1_000_000;
  let loaded: LoadedManifest = options.loaded ?? { status: "ok", manifest: manifestOf(), hash: "a".repeat(64) };
  const state = { iterm: options.iterm ?? true, allow: options.allow ?? true, launch: options.launch ?? { code: 0, stderr: "" } };

  const handlers = createRunHandlers({
    db,
    logger: { log: (entry) => void logs.push(entry.message) },
    loadManifest: async () => loaded,
    probe: async (port) => listening.has(port),
    allocatePorts: async (count) => Array.from({ length: count }, () => (next += 1)),
    writePortsFile: async (folder, services) => {
      written.push({ folder, services });
      return true;
    },
    itermAvailable: () => state.iterm,
    inspect: async (path) => (path === "/work/file" ? "file" : path.startsWith("/work/") ? "dir" : "missing"),
    launchTabs: async (tabs) => {
      launched.push(tabs);
      return state.launch;
    },
    confirmCommands: async (request) => {
      confirms.push(request);
      return state.allow;
    },
    openUrl: async (url) => void opened.push(url),
    vault,
    copySecret: (secret) => void copied.push(secret),
    now: () => time,
    startingGraceMs: 60_000
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
    listening,
    launched,
    opened,
    confirms,
    written,
    logs,
    copied,
    cipher,
    vault,
    state,
    project,
    setLoaded: (value: LoadedManifest) => void (loaded = value),
    advance: (ms: number) => void (time += ms)
  };
};

const ok = (value: { ok: boolean }): void => assert.equal(value.ok, true, JSON.stringify(value));

describe("run handlers: listing", () => {
  it("lists projects that have a local path plus added folders, without duplicates", async () => {
    const h = harness();
    const first = h.project("/work/app");
    h.project(null);
    await h.handlers.addFolder("/work/extra");
    await h.handlers.addFolder("/work/app");
    const overview = await h.handlers.overview();
    assert.deepEqual(overview.targets.map((target) => [target.id, target.source, target.folder]), [
      [`p:${first.id}`, "project", "/work/app"],
      ["f:1", "folder", "/work/extra"]
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
  it("opens one tab per backend/frontend service in order, with ports wired together", async () => {
    const h = harness();
    const project = h.project();
    ok(await h.handlers.run(`p:${project.id}`, "all"));

    assert.equal(h.launched.length, 1);
    assert.deepEqual(h.launched[0]?.map((tab) => [tab.name, tab.dir]), [["api", "/work/app/api"], ["web", "/work/app"]]);
    assert.equal(h.launched[0]?.[0]?.command, "env DEV_PORT=41001 FRONT=http://localhost:41002 pnpm dev");
    assert.equal(h.launched[0]?.[1]?.command, "env PORT=41002 API=http://localhost:41001 pnpm dev");
    assert.deepEqual(h.written[0]?.services, { api: { role: "backend", port: 41001 }, web: { role: "frontend", port: 41002 } });
    assert.ok(h.logs.some((line) => line.includes("已在 iTerm2 啟動")));
  });

  it("reports services as starting, then running once they listen, then stopped again", async () => {
    const h = harness();
    const project = h.project();
    await h.handlers.run(`p:${project.id}`, "all");

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
    await h.handlers.run(`p:${project.id}`, "all");
    h.listening.add(41001);
    h.listening.add(41002);
    const again = await h.handlers.run(`p:${project.id}`, "all");
    ok(again);
    assert.equal(h.launched.length, 1);
    assert.match(again.ok ? again.message : "", /已經在執行中/);
  });

  it("starts only what is down and keeps the running service's port", async () => {
    const h = harness();
    const project = h.project();
    await h.handlers.run(`p:${project.id}`, "all");
    h.listening.add(41001);
    h.advance(61_000);
    ok(await h.handlers.run(`p:${project.id}`, "all"));

    assert.equal(h.launched.length, 2);
    assert.deepEqual(h.launched[1]?.map((tab) => tab.name), ["web"]);
    // 第一次配置時三個有 port 的服務各拿一個（41001～41003）；第二次只有 web、panel 需要新的。
    assert.equal(h.launched[1]?.[0]?.command, "env PORT=41004 API=http://localhost:41001 pnpm dev");
  });

  it("the desktop action starts its needed service and reuses one that is already running", async () => {
    const h = harness();
    const project = h.project();
    ok(await h.handlers.run(`p:${project.id}`, "desktop"));
    assert.deepEqual(h.launched[0]?.map((tab) => tab.name), ["api", "panel"]);

    const second = harness();
    const other = second.project();
    await second.handlers.run(`p:${other.id}`, "all");
    second.listening.add(41001);
    ok(await second.handlers.run(`p:${other.id}`, "desktop"));
    assert.deepEqual(second.launched[1]?.map((tab) => tab.name), ["panel"]);
    assert.match(second.launched[1]?.[0]?.command ?? "", /API=http:\/\/localhost:41001/);
  });

  it("never touches the terminal setting: it needs iTerm2 and says so when it is missing", async () => {
    const h = harness({ iterm: false });
    const project = h.project();
    const result = await h.handlers.run(`p:${project.id}`, "all");
    assert.deepEqual([result.ok, result.ok ? "" : result.reason], [false, "iterm-missing"]);
    assert.equal(h.launched.length, 0);
    assert.equal(h.confirms.length, 0);
  });

  it("maps a denied macOS automation permission and other launch errors", async () => {
    const denied = harness({ launch: { code: 1, stderr: "execution error: Not authorized to send Apple events to iTerm. (-1743)" } });
    const a = denied.project();
    const result = await denied.handlers.run(`p:${a.id}`, "all");
    assert.deepEqual([result.ok, result.ok ? "" : result.reason], [false, "permission-denied"]);

    const broken = harness({ launch: { code: 1, stderr: "boom" } });
    const b = broken.project();
    const failed = await broken.handlers.run(`p:${b.id}`, "all");
    assert.deepEqual([failed.ok, failed.ok ? "" : failed.reason], [false, "failed"]);
    // 沒啟動成功就不能留下「啟動中」的假狀態。
    assert.deepEqual((await broken.handlers.overview()).targets[0]?.services.map((service) => service.state), ["stopped", "stopped", "stopped"]);
  });

  it("rejects unknown targets and manifests that are missing or invalid", async () => {
    const h = harness();
    const project = h.project();
    const unknown = await h.handlers.run("p:999", "all");
    assert.deepEqual([unknown.ok, unknown.ok ? "" : unknown.reason], [false, "unknown-target"]);
    h.setLoaded({ status: "missing" });
    const missing = await h.handlers.run(`p:${project.id}`, "all");
    assert.deepEqual([missing.ok, missing.ok ? "" : missing.reason], [false, "no-manifest"]);
    h.setLoaded({ status: "invalid", errors: ["x"] });
    const invalid = await h.handlers.run(`p:${project.id}`, "all");
    assert.deepEqual([invalid.ok, invalid.ok ? "" : invalid.reason], [false, "invalid-manifest"]);
    assert.equal(h.launched.length, 0);
  });

  it("says there is nothing to do when the project has no such services", async () => {
    const result = validateManifest({ version: 1, services: [{ name: "panel", role: "desktop", command: ["pnpm", "dev"], port: true }] });
    assert.ok(result.ok);
    const h = harness({ loaded: { status: "ok", manifest: result.manifest, hash: "b".repeat(64) } });
    const project = h.project();
    const none = await h.handlers.run(`p:${project.id}`, "all");
    assert.deepEqual([none.ok, none.ok ? "" : none.reason], [false, "nothing-to-do"]);
  });
});

describe("run handlers: trust confirmation", () => {
  it("asks before the first run, lists every command, and remembers the answer", async () => {
    const h = harness();
    const project = h.project();
    ok(await h.handlers.run(`p:${project.id}`, "all"));
    assert.equal(h.confirms.length, 1);
    assert.equal(h.confirms[0]?.changed, false);
    assert.deepEqual(h.confirms[0]?.lines.map((line) => line.service), ["api", "web", "panel"]);
    assert.equal(isRunTrusted(h.db, "/work/app", "a".repeat(64)), true);

    h.advance(61_000);
    ok(await h.handlers.run(`p:${project.id}`, "all"));
    assert.equal(h.confirms.length, 1);
  });

  it("sends nothing to iTerm2 when the user refuses, and asks again next time", async () => {
    const h = harness({ allow: false });
    const project = h.project();
    const result = await h.handlers.run(`p:${project.id}`, "all");
    assert.deepEqual([result.ok, result.ok ? "" : result.reason], [false, "denied"]);
    assert.equal(h.launched.length, 0);
    assert.equal(h.written.length, 0);
    assert.equal(isRunTrusted(h.db, "/work/app", "a".repeat(64)), false);
    await h.handlers.run(`p:${project.id}`, "all");
    assert.equal(h.confirms.length, 2);
  });

  it("asks again, flagged as changed, when the manifest content changes", async () => {
    const h = harness();
    const project = h.project();
    await h.handlers.run(`p:${project.id}`, "all");
    h.advance(61_000);
    h.setLoaded({ status: "ok", manifest: manifestOf(), hash: "c".repeat(64) });
    await h.handlers.run(`p:${project.id}`, "all");
    assert.equal(h.confirms.length, 2);
    assert.equal(h.confirms[1]?.changed, true);
  });
});

describe("run handlers: open web", () => {
  it("refuses until a frontend is listening, then opens only that local address", async () => {
    const h = harness();
    const project = h.project();
    const early = await h.handlers.run(`p:${project.id}`, "web");
    assert.deepEqual([early.ok, early.ok ? "" : early.reason], [false, "not-running"]);

    await h.handlers.run(`p:${project.id}`, "all");
    const stillStarting = await h.handlers.run(`p:${project.id}`, "web");
    assert.equal(stillStarting.ok, false);

    h.listening.add(41002);
    ok(await h.handlers.run(`p:${project.id}`, "web"));
    assert.deepEqual(h.opened, ["http://localhost:41002"]);
    assert.equal(h.launched.length, 1);
  });

  it("never asks for confirmation or starts anything", async () => {
    const h = harness();
    const project = h.project();
    await h.handlers.run(`p:${project.id}`, "web");
    assert.equal(h.confirms.length, 0);
    assert.equal(h.launched.length, 0);
  });
});

describe("run handlers: dev account and passcode", () => {
  const PASSCODE = "dev-passcode-0042";

  it("shows an empty account and an unset passcode for every target, even without a manifest", async () => {
    const h = harness({ loaded: { status: "missing" } });
    const project = h.project();
    const overview = await h.handlers.overview();
    assert.equal(overview.vaultAvailable, true);
    const [target] = overview.targets;
    assert.equal(target?.manifest, "missing");
    assert.equal(target?.account, "");
    assert.deepEqual(target?.passcode, { name: `devpass.p${project.id}`, configured: false, state: "missing", hint: "", updatedAt: null });
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

  it("copies the saved passcode through the injected clipboard and never exposes it in the overview", async () => {
    const h = harness();
    const project = h.project();
    const id = `p:${project.id}`;
    h.vault.set(`devpass.p${project.id}`, PASSCODE);
    await h.handlers.copyPasscode(id);
    assert.deepEqual(h.copied, [PASSCODE]);
    const overview = await h.handlers.overview();
    assert.equal(overview.targets[0]?.passcode.configured, true);
    assert.equal(overview.targets[0]?.passcode.hint, "0042");
    assert.equal(JSON.stringify(overview).includes(PASSCODE), false);
  });

  it("explains why a passcode cannot be copied", async () => {
    const h = harness();
    const project = h.project();
    const id = `p:${project.id}`;
    await assert.rejects(h.handlers.copyPasscode(id), (error: Error) => error instanceof UserFacingError && error.message === "還沒有設定密碼");
    await assert.rejects(h.handlers.copyPasscode("p:999"), UserFacingError);

    h.vault.set(`devpass.p${project.id}`, PASSCODE);
    h.cipher.brokenCiphertexts.add(String(h.db.prepare("SELECT ciphertext FROM api_keys WHERE name = ?").get(`devpass.p${project.id}`)?.ciphertext));
    await assert.rejects(h.handlers.copyPasscode(id), (error: Error) => error instanceof UserFacingError && /重新輸入/.test(error.message));
    assert.deepEqual(h.copied, []);
  });

  it("reports an unavailable vault but still keeps accounts working", async () => {
    const h = harness();
    const project = h.project();
    h.cipher.available = false;
    assert.equal((await h.handlers.overview()).vaultAvailable, false);
    h.handlers.setAccount(`p:${project.id}`, "alice");
    assert.equal((await h.handlers.overview()).targets[0]?.account, "alice");
  });

  it("removes the account and passcode together with an added folder, so a reused id starts empty", async () => {
    const h = harness();
    await h.handlers.addFolder("/work/extra");
    h.handlers.setAccount("f:1", "bob");
    h.vault.set("devpass.f1", PASSCODE);
    h.handlers.removeFolder("f:1");
    assert.equal(getRunAccount(h.db, "f:1"), "");
    assert.equal(h.vault.has("devpass.f1"), false);

    await h.handlers.addFolder("/work/another");
    const [target] = (await h.handlers.overview()).targets;
    assert.equal(target?.id, "f:1");
    assert.equal(target?.account, "");
    assert.equal(target?.passcode.configured, false);
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
