import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildCommandLine,
  countFreshPorts,
  describeCommand,
  displayServiceName,
  expandPlaceholders,
  groupRunServices,
  isRunTargetId,
  mobilePlatformOf,
  parseRunTargetId,
  planMobileStop,
  planStart,
  runButtonStates,
  selectServices,
  shellQuote,
  summarizeMobileState,
  validateManifest,
  type RunManifest
} from "@shared/run";
import { FLUTTER_ANDROID_RUN_SCRIPT, FLUTTER_IOS_RUN_SCRIPT, jsonErrorPosition, loadManifest, type ManifestFs } from "@main/run/manifest";
import { simulatorShutdownCommand } from "@main/run/runtime";
import { hasTrustedBefore, isRunTrusted, trustRunManifest, addRunFolder, listRunFolders, removeRunFolder } from "@main/run/store";
import { createTestDb } from "./helpers/db";

const service = (overrides: Record<string, unknown> = {}) => ({
  name: "api",
  role: "backend",
  command: ["pnpm", "dev"],
  port: true,
  ...overrides
});

const manifestOf = (...services: Array<Record<string, unknown>>) => ({ version: 1, services });

const expectErrors = (raw: unknown): string[] => {
  const result = validateManifest(raw);
  assert.equal(result.ok, false);
  return result.ok ? [] : result.errors;
};

const parsed = (raw: unknown): RunManifest => {
  const result = validateManifest(raw);
  assert.ok(result.ok, JSON.stringify(result));
  return result.manifest;
};

const stack = (): RunManifest =>
  parsed(
    manifestOf(
      service({ name: "api", env: { DEV_PORT: "{port}", FRONTEND_URL: "{web.url}" } }),
      service({ name: "web", role: "frontend", command: ["pnpm", "dev"], needs: ["api"], env: { PORT: "{port}", API_BASE: "{api.url}" } }),
      service({ name: "panel", role: "desktop", port: false, command: ["pnpm", "dev:desktop"], needs: ["api"], env: { API: "{api.url}" } })
    )
  );

describe("validateManifest", () => {
  it("accepts a valid manifest and normalizes defaults", () => {
    const manifest = parsed(manifestOf(service({ cwd: "./apps/api/" })));
    assert.equal(manifest.services[0]?.cwd, "apps/api");
    assert.deepEqual(manifest.services[0]?.env, {});
    assert.deepEqual(manifest.services[0]?.needs, []);
    assert.equal(parsed(manifestOf(service())).services[0]?.cwd, ".");
  });

  it("rejects non-objects, wrong version, unknown keys and bad service lists", () => {
    for (const raw of [null, [], "x", 3]) expectErrors(raw);
    assert.ok(expectErrors({ version: 2, services: [service()] }).some((error) => error.includes("version")));
    assert.ok(expectErrors({ version: 1, services: [service()], extra: 1 }).some((error) => error.includes("最上層")));
    expectErrors({ version: 1, services: [] });
    expectErrors({ version: 1 });
    expectErrors({ version: 1, services: Array.from({ length: 13 }, (_, i) => service({ name: `s${i}` })) });
  });

  it("rejects bad names, roles, commands and unknown service keys", () => {
    expectErrors(manifestOf(service({ name: "Api" })));
    expectErrors(manifestOf(service({ name: "1api" })));
    expectErrors(manifestOf(service({ role: "database" })));
    expectErrors(manifestOf(service({ command: [] })));
    expectErrors(manifestOf(service({ command: "pnpm dev" })));
    expectErrors(manifestOf(service({ command: ["pnpm", 3] })));
    expectErrors(manifestOf(service({ command: ["-rf"] })));
    expectErrors(manifestOf(service({ command: ["pnpm", "dev\nrm -rf /"] })));
    expectErrors(manifestOf(service({ command: ["x".repeat(501)] })));
    expectErrors(manifestOf(service({ shell: true })));
  });

  it("requires a port for backend and frontend services", () => {
    expectErrors(manifestOf(service({ port: false })));
    expectErrors(manifestOf(service({ role: "frontend", port: undefined })));
    parsed(manifestOf(service({ role: "desktop", port: false })));
  });

  it("accepts fixed ports and rejects invalid, duplicate or portless values", () => {
    assert.equal(parsed(manifestOf(service({ fixedPort: 5174 }))).services[0]?.fixedPort, 5174);
    for (const fixedPort of [0, 80, 65536, 5174.5, "5174", null]) {
      assert.ok(expectErrors(manifestOf(service({ fixedPort }))).some((error) => error.includes("fixedPort")));
    }
    expectErrors(manifestOf(service({ role: "desktop", port: false, fixedPort: 5174 })));
    assert.ok(expectErrors(manifestOf(service({ fixedPort: 5174 }), service({ name: "edge", fixedPort: 5174 }))).some((error) => error.includes("重複")));
  });

  it("names every unknown key and hints at underscore comments", () => {
    const top = expectErrors({ version: 1, services: [service()], _note: "說明", extra: 1 });
    assert.ok(top.some((error) => error.includes("最上層") && error.includes("_note、extra") && error.includes("請刪除")));
    const nested = expectErrors(manifestOf(service({ _comment: "說明", shell: true })));
    assert.ok(nested.some((error) => error.includes("services[0]（api）") && error.includes("_comment、shell") && error.includes("請刪除")));
  });

  it("keeps the index label when the service name is not valid", () => {
    const errors = expectErrors(manifestOf(service({ name: "Api", shell: true })));
    assert.ok(errors.some((error) => error.startsWith("services[0]：有不認得的欄位 shell")));
    assert.ok(errors.some((error) => error.startsWith("services[0].name")));
  });

  it("keeps the example file in step with the validator", () => {
    const example = JSON.parse(readFileSync(join(process.cwd(), "docs/gitnrun-run.example.json"), "utf8")) as Record<string, unknown>;
    const errors = expectErrors(example);
    assert.ok(errors.length > 0);
    assert.ok(errors.every((error) => /有不認得的欄位 _/.test(error)), JSON.stringify(errors));
    const withoutUnderscore = (value: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith("_")));
    const services = example.services as Array<Record<string, unknown>>;
    parsed({ ...withoutUnderscore(example), services: services.map(withoutUnderscore) });
  });

  it("rejects duplicate names", () => {
    expectErrors(manifestOf(service(), service()));
  });

  it("rejects dangerous or malformed environment variables", () => {
    for (const name of ["PATH", "HOME", "NODE_OPTIONS", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "BASH_ENV"]) {
      assert.ok(expectErrors(manifestOf(service({ env: { [name]: "x" } }))).length > 0, name);
    }
    expectErrors(manifestOf(service({ env: { lower: "x" } })));
    expectErrors(manifestOf(service({ env: { OK: 1 } })));
    expectErrors(manifestOf(service({ env: { OK: "a\u0000b" } })));
    expectErrors(manifestOf(service({ env: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`V${i}`, "x"])) })));
    parsed(manifestOf(service({ env: { DEV_PORT: "{port}", API_BASE: "http://x" } })));
  });

  it("rejects working directories that are absolute or climb out of the project", () => {
    for (const cwd of ["/etc", "../x", "a/../../x", "a/..", "", "a\nb"]) {
      expectErrors(manifestOf(service({ cwd })));
    }
    expectErrors(manifestOf(service({ cwd: 3 })));
  });

  it("checks placeholders: unknown services, services without a port, and typos", () => {
    expectErrors(manifestOf(service({ env: { X: "{ghost.port}" } })));
    expectErrors(manifestOf(service(), service({ name: "tool", role: "desktop", port: false }), service({ name: "web", role: "frontend", env: { X: "{tool.url}" } })));
    expectErrors(manifestOf(service({ env: { X: "{prot}" } })));
    expectErrors(manifestOf(service({ command: ["echo", "{"] })));
    expectErrors(manifestOf(service({ role: "desktop", port: false, env: { X: "{port}" } })));
    parsed(manifestOf(service({ env: { X: "{port}", Y: "{url}" } })));
  });

  it("allows services to reference each other's ports, but not to need each other in a loop", () => {
    stack();
    expectErrors(manifestOf(service({ name: "a", needs: ["b"] }), service({ name: "b", needs: ["a"] })));
    expectErrors(manifestOf(service({ name: "a", needs: ["a"] })));
    expectErrors(manifestOf(service({ name: "a", needs: ["ghost"] })));
  });
});

describe("shellQuote and buildCommandLine", () => {
  it("keeps plain tokens readable and quotes everything else", () => {
    assert.equal(shellQuote("pnpm"), "pnpm");
    assert.equal(shellQuote("--filter=web"), "--filter=web");
    assert.equal(shellQuote("http://localhost:3000"), "http://localhost:3000");
    assert.equal(shellQuote("a b"), "'a b'");
    assert.equal(shellQuote("it's"), `'it'\\''s'`);
    assert.equal(shellQuote(""), "''");
  });

  it("cannot be escaped by quotes, $, backticks, newlines or semicolons in values", () => {
    const hostile = `x'; rm -rf / #$(whoami)\`id\`\n"y"`;
    const line = buildCommandLine(["echo", hostile], { A: hostile });
    // 引用之後整段只剩單引號包住的字面值：去掉所有引用片段後不應留下任何會被 shell 解讀的字元。
    const stripped = line.replace(/'(?:[^']|'\\'')*'/g, "");
    assert.equal(/[;$`\n"&|<>()#]/.test(stripped), false, stripped);
    assert.ok(line.startsWith("env "));
  });

  it("survives a real shell: hostile text comes back byte for byte and nothing extra runs", (t) => {
    const hostile = `a'b"c $HOME \`id\` $(whoami); echo INJECTED && true | cat > /dev/null #\\ 中文 {port}`;
    const line = buildCommandLine(["printf", "%s|%s", hostile, "tail"], { HOSTILE: hostile });
    for (const shell of ["/bin/sh", "/bin/zsh", "/bin/bash"]) {
      if (!existsSync(shell)) continue;
      assert.equal(execFileSync(shell, ["-c", line], { encoding: "utf8" }), `${hostile}|tail`, shell);
      const viaEnv = buildCommandLine(["sh", "-c", 'printf %s "$HOSTILE"'], { HOSTILE: hostile });
      assert.equal(execFileSync(shell, ["-c", viaEnv], { encoding: "utf8" }), hostile, shell);
    }
    t.diagnostic("checked with every shell that exists on this machine");
  });

  it("adds env only when there are variables", () => {
    assert.equal(buildCommandLine(["pnpm", "dev"], {}), "pnpm dev");
    assert.equal(buildCommandLine(["pnpm", "dev"], { PORT: "123", API: "http://a b" }), "env PORT=123 'API=http://a b' pnpm dev");
  });

  it("describes a command for display without quoting", () => {
    assert.equal(describeCommand({ command: ["pnpm", "dev"], env: { PORT: "{port}" } }), "PORT={port} pnpm dev");
  });
});

describe("placeholders", () => {
  it("expands own and other services' port and url", () => {
    const ports = { api: 5001, web: 5002 };
    assert.equal(expandPlaceholders("{port}", "api", ports), "5001");
    assert.equal(expandPlaceholders("{url}", "web", ports), "http://localhost:5002");
    assert.equal(expandPlaceholders("{api.url}/x?p={web.port}", "web", ports), "http://localhost:5001/x?p=5002");
    assert.throws(() => expandPlaceholders("{ghost.port}", "web", ports));
  });
});

describe("selectServices and planStart", () => {
  it("one-click start picks backends then frontends and skips desktop", () => {
    assert.deepEqual(selectServices(stack(), "all").map((item) => item.name), ["api", "web"]);
  });

  it("desktop pulls in its needed services first", () => {
    assert.deepEqual(selectServices(stack(), "desktop").map((item) => item.name), ["api", "panel"]);
  });

  it("a service-scoped start pulls only that service and its needs", () => {
    assert.deepEqual(selectServices(stack(), { service: "web" }).map((item) => item.name), ["api", "web"]);
  });

  it("service-scoped frontend starts do not pull sibling frontends", () => {
    const manifest = parsed(
      manifestOf(
        service({ name: "api" }),
        service({ name: "fictionpurr", role: "frontend", needs: ["api"] }),
        service({ name: "sparkpurr", role: "frontend", needs: ["api"] })
      )
    );
    assert.deepEqual(selectServices(manifest, { service: "sparkpurr" }).map((item) => item.name), ["api", "sparkpurr"]);
  });

  it("orders a needed service before the one that needs it regardless of declaration order", () => {
    const manifest = parsed(manifestOf(service({ name: "api", needs: ["db"] }), service({ name: "db" })));
    assert.deepEqual(selectServices(manifest, "all").map((item) => item.name), ["db", "api"]);
  });

  it("assigns every port-service a distinct port and wires services to each other", () => {
    const manifest = stack();
    assert.equal(countFreshPorts(manifest, {}), 2);
    const plan = planStart(manifest, "all", {}, new Set(), [4001, 4002]);
    assert.deepEqual(plan.ports, { api: 4001, web: 4002 });
    assert.deepEqual(
      plan.starts.map((item) => [item.name, item.commandLine, item.port]),
      [
        ["api", "env DEV_PORT=4001 FRONTEND_URL=http://localhost:4002 pnpm dev", 4001],
        ["web", "env PORT=4002 API_BASE=http://localhost:4001 pnpm dev", 4002]
      ]
    );
  });

  it("combines a fixed API port with a dynamically allocated frontend port", () => {
    const manifest = parsed(manifestOf(service({ fixedPort: 5174, env: { PORT: "{port}" } }), service({ name: "web", role: "frontend", env: { API: "{api.url}", PORT: "{port}" } })));
    assert.equal(countFreshPorts(manifest, {}), 1);
    const plan = planStart(manifest, "all", {}, new Set(), [41001]);
    assert.deepEqual(plan.ports, { api: 5174, web: 41001 });
    assert.equal(plan.starts[1]?.commandLine, "env API=http://localhost:5174 PORT=41001 pnpm dev");
  });

  it("reuses ports of services that are already up and does not start them again", () => {
    const manifest = stack();
    assert.equal(countFreshPorts(manifest, { api: 4001 }), 1);
    const plan = planStart(manifest, "desktop", { api: 4001 }, new Set(["api"]), [4009]);
    assert.deepEqual(plan.ports, { api: 4001, web: 4009 });
    assert.deepEqual(plan.starts.map((item) => [item.name, item.commandLine]), [["panel", "env API=http://localhost:4001 pnpm dev:desktop"]]);
  });

  it("fails loudly when too few fresh ports are provided", () => {
    assert.throws(() => planStart(stack(), "all", {}, new Set(), [1]));
  });
});

describe("runButtonStates", () => {
  const web = { role: "frontend" as const, hasPort: true, hasSession: false };
  const api = { role: "backend" as const, hasPort: true, hasSession: false };
  const panel = { role: "desktop" as const, hasPort: true, hasSession: false };

  it("disables everything with a reason when there is no usable manifest", () => {
    const missing = runButtonStates({ manifest: "missing", services: [], iterm: true });
    assert.deepEqual([missing.all.enabled, missing.restart.enabled, missing.stop.enabled, missing.web.enabled, missing.desktop.enabled], [false, false, false, false, false]);
    assert.equal(missing.all.reason, "找不到可啟動服務");
    assert.match(runButtonStates({ manifest: "invalid", services: [], iterm: true }).web.reason ?? "", /有誤/);
  });

  it("explains why a button is unavailable", () => {
    const noDesktop = runButtonStates({ manifest: "ok", services: [{ ...api, state: "stopped" }, { ...web, state: "stopped" }], iterm: true });
    assert.equal(noDesktop.all.enabled, true);
    assert.equal(noDesktop.stop.reason, "尚未啟動");
    assert.equal(noDesktop.web.reason, "前端尚未啟動（先按一鍵前後端）");
    assert.equal(noDesktop.desktop.reason, "沒有桌面版");

    const desktopOnly = runButtonStates({ manifest: "ok", services: [{ ...panel, state: "stopped" }], iterm: true });
    assert.equal(desktopOnly.all.reason, "沒有後端或前端服務");
    assert.equal(desktopOnly.web.reason, "沒有網頁前端");
    assert.equal(desktopOnly.desktop.enabled, true);
  });

  it("needs iTerm2 for the launching buttons but not for opening the web page", () => {
    const states = runButtonStates({ manifest: "ok", services: [{ ...api, state: "running" }, { ...web, state: "running" }, { ...panel, state: "stopped" }], iterm: false });
    assert.equal(states.all.reason, "找不到 iTerm2");
    assert.equal(states.restart.reason, "找不到 iTerm2");
    assert.equal(states.stop.enabled, true);
    assert.equal(states.desktop.reason, "找不到 iTerm2");
    assert.equal(states.web.enabled, true);
  });

  it("disables buttons for things that are already running", () => {
    const states = runButtonStates({ manifest: "ok", services: [{ ...api, state: "running" }, { ...web, state: "starting" }, { ...panel, state: "running" }], iterm: true });
    assert.equal(states.all.reason, "已在執行中");
    assert.equal(states.restart.enabled, true);
    assert.equal(states.stop.enabled, true);
    assert.equal(states.desktop.reason, "桌面版已在執行中");
    assert.equal(states.web.enabled, false);
  });

  it("never disables a desktop service that cannot be detected", () => {
    const states = runButtonStates({ manifest: "ok", services: [{ ...panel, hasPort: false, state: "stopped" }], iterm: true });
    assert.equal(states.desktop.enabled, true);
  });
});

describe("target ids", () => {
  it("accepts only p:N and f:N", () => {
    assert.equal(isRunTargetId("p:1"), true);
    assert.equal(isRunTargetId("f:123456789"), true);
    for (const bad of ["p:0", "p:01", "x:1", "p:", "p:1:2", "p:1234567890", "", 3, null, "../etc"]) {
      assert.equal(isRunTargetId(bad), false, String(bad));
    }
    assert.deepEqual(parseRunTargetId("f:7"), { kind: "f", id: 7 });
    assert.equal(parseRunTargetId("zzz"), null);
  });
});

const fakeFs = (files: Record<string, string>, links: Record<string, string> = {}, dirs: string[] = ["/work/app"]): ManifestFs => ({
  async lstat(path) {
    if (links[path] !== undefined) return { size: 10, isFile: false, isSymbolicLink: true };
    const body = files[path];
    return body === undefined ? null : { size: body.length, isFile: true, isSymbolicLink: false };
  },
  async readFile(path) {
    const body = files[path];
    if (body === undefined) throw new Error("ENOENT");
    return body;
  },
  async realpath(path) {
    if (links[path] !== undefined) return links[path] ?? null;
    return files[path] !== undefined || dirs.includes(path) ? path : null;
  }
});

describe("jsonErrorPosition", () => {
  it("turns the line and column of a JSON.parse error into a Chinese position", () => {
    assert.equal(jsonErrorPosition("Expected ',' or '}' after property value in JSON at position 49 (line 3 column 32)"), "第 3 行第 32 欄");
  });

  it("returns null when the message has no position, so callers keep the plain text", () => {
    assert.equal(jsonErrorPosition("Unexpected end of JSON input"), null);
  });
});

describe("loadManifest", () => {
  const file = "/work/app/.gitnrun/run.json";
  const good = JSON.stringify(manifestOf(service({ cwd: "api" })));

  it("reports a missing manifest", async () => {
    assert.deepEqual(await loadManifest("/work/app", fakeFs({})), { status: "missing" });
  });

  it("infers services from package.json scripts when no manifest file exists", async () => {
    const packageFile = "/work/app/package.json";
    const result = await loadManifest(
      "/work/app",
      fakeFs({
        [packageFile]: JSON.stringify({
          packageManager: "pnpm@9.15.9",
          scripts: {
            "dev:api": "tsx api.ts",
            "dev:web": "vite",
            "dev:desktop": "electron-vite dev"
          }
        })
      })
    );

    assert.equal(result.status, "ok");
    assert.deepEqual(
      result.status === "ok" ? result.manifest.services.map((item) => [item.name, item.role, item.command, item.env, item.needs]) : [],
      [
        ["api", "backend", ["pnpm", "run", "dev:api"], { PORT: "{port}", DEV_PORT: "{port}" }, []],
        [
          "web",
          "frontend",
          ["pnpm", "run", "dev:web"],
          { PORT: "{port}", DEV_PORT: "{port}", API_BASE_URL: "{api.url}", VITE_API_BASE_URL: "{api.url}" },
          []
        ],
        ["desktop", "desktop", ["pnpm", "run", "dev:desktop"], {}, ["api"]]
      ]
    );
  });

  it("infers a Flutter web service plus separate iOS and Android services from pubspec.yaml when no package scripts exist", async () => {
    const result = await loadManifest(
      "/work/app",
      fakeFs({
        "/work/app/pubspec.yaml": "name: mobile_app\n"
      })
    );

    assert.equal(result.status, "ok");
    assert.deepEqual(
      result.status === "ok" ? result.manifest.services.map((item) => [item.name, item.role, item.command, item.port]) : [],
      [
        ["flutter", "frontend", ["flutter", "run", "-d", "chrome", "--web-port", "{port}"], true],
        ["flutter-ios", "desktop", ["zsh", "-lc", FLUTTER_IOS_RUN_SCRIPT], false],
        ["flutter-android", "desktop", ["zsh", "-lc", FLUTTER_ANDROID_RUN_SCRIPT], false]
      ]
    );
    // 一次只會啟動被點的那個服務，iOS 與 Android 不會一起被帶起來。
    assert.deepEqual(result.status === "ok" ? selectServices(result.manifest, { service: "flutter-ios" }).map((item) => item.name) : [], ["flutter-ios"]);
    assert.deepEqual(result.status === "ok" ? selectServices(result.manifest, { service: "flutter-android" }).map((item) => item.name) : [], ["flutter-android"]);
  });

  it("does not read a manifest from the retired folder name", async () => {
    const retiredFile = `/work/app/.${["push", "watch"].join("")}/run.json`;
    assert.deepEqual(await loadManifest("/work/app", fakeFs({ [retiredFile]: good }, {}, ["/work/app", "/work/app/api"])), { status: "missing" });
  });

  it("loads a valid manifest and returns a stable content hash", async () => {
    const fs = fakeFs({ [file]: good }, {}, ["/work/app", "/work/app/api"]);
    const first = await loadManifest("/work/app", fs);
    const second = await loadManifest("/work/app", fs);
    assert.equal(first.status, "ok");
    assert.equal(first.status === "ok" && /^[0-9a-f]{64}$/.test(first.hash), true);
    assert.deepEqual(first, second);
    const changed = await loadManifest("/work/app", fakeFs({ [file]: good.replace("dev", "start") }, {}, ["/work/app", "/work/app/api"]));
    assert.equal(changed.status === "ok" && first.status === "ok" && changed.hash !== first.hash, true);
  });

  it("rejects broken JSON, invalid content and oversize files", async () => {
    const dirs = ["/work/app", "/work/app/api"];
    assert.equal((await loadManifest("/work/app", fakeFs({ [file]: "{nope" }, {}, dirs))).status, "invalid");
    assert.equal((await loadManifest("/work/app", fakeFs({ [file]: JSON.stringify({ version: 1, services: [] }) }, {}, dirs))).status, "invalid");
    assert.equal((await loadManifest("/work/app", fakeFs({ [file]: " ".repeat(70 * 1024) }, {}, dirs))).status, "invalid");
  });

  it("points at the line and column of broken run.json syntax", async () => {
    const broken = '{\n  "version": 1,\n  "services": [ {"name": "api" "role": "backend"} ]\n}';
    const result = await loadManifest("/work/app", fakeFs({ [file]: broken }, {}, ["/work/app", "/work/app/api"]));
    assert.equal(result.status, "invalid");
    assert.ok(result.status === "invalid" && result.errors[0]?.startsWith(".gitnrun/run.json 不是合法的 JSON（第 3 行第"));
  });

  it("rejects a manifest that is a link pointing outside the project", async () => {
    const result = await loadManifest("/work/app", fakeFs({}, { [file]: "/etc/passwd" }));
    assert.equal(result.status, "invalid");
  });

  it("rejects a working directory that does not exist or resolves outside the project", async () => {
    const missingDir = await loadManifest("/work/app", fakeFs({ [file]: good }, {}, ["/work/app"]));
    assert.equal(missingDir.status, "invalid");
    assert.match(missingDir.status === "invalid" ? missingDir.errors.join() : "", /找不到資料夾/);

    const fs = fakeFs({ [file]: good }, { "/work/app/api": "/elsewhere/api" }, ["/work/app"]);
    const escaped = await loadManifest("/work/app", fs);
    assert.equal(escaped.status, "invalid");
    assert.match(escaped.status === "invalid" ? escaped.errors.join() : "", /專案資料夾外/);
  });
});

describe("run store", () => {
  it("remembers trusted manifest hashes per folder and notices changes", () => {
    const db = createTestDb();
    const hash = "a".repeat(64);
    assert.equal(isRunTrusted(db, "/work/app", hash), false);
    assert.equal(hasTrustedBefore(db, "/work/app"), false);

    trustRunManifest(db, "/work/app/", hash);
    assert.equal(isRunTrusted(db, "/work/app", hash), true);
    assert.equal(hasTrustedBefore(db, "/work/app"), true);
    assert.equal(isRunTrusted(db, "/work/app", "b".repeat(64)), false);
    assert.equal(isRunTrusted(db, "/work/other", hash), false);
  });

  it("adds, de-duplicates and removes folders", () => {
    const db = createTestDb();
    const first = addRunFolder(db, "/work/a/");
    const again = addRunFolder(db, "/work/a");
    const second = addRunFolder(db, "/work/b");
    assert.equal(first.id, again.id);
    assert.notEqual(first.id, second.id);
    assert.deepEqual(listRunFolders(db).map((entry) => entry.path), ["/work/a", "/work/b"]);
    assert.equal(removeRunFolder(db, first.id), true);
    assert.equal(removeRunFolder(db, first.id), false);
    assert.deepEqual(listRunFolders(db).map((entry) => entry.path), ["/work/b"]);
  });
});

describe("mobile services share one row", () => {
  const names = (rows: ReturnType<typeof groupRunServices<{ name: string }>>) =>
    rows.map((row) => (row.kind === "service" ? row.service.name : `mobile:${row.services.map((item) => item.service.name).join("+")}`));
  const titles = (rows: ReturnType<typeof groupRunServices<{ name: string }>>) => rows.flatMap((row) => (row.kind === "mobile" ? [row.title] : []));
  const of = (...list: string[]) => list.map((name) => ({ name }));

  it("recognises ios and android only as hyphen-separated name parts", () => {
    assert.equal(mobilePlatformOf("flutter-ios"), "ios");
    assert.equal(mobilePlatformOf("android-dev"), "android");
    assert.equal(mobilePlatformOf("iOS"), "ios");
    assert.equal(mobilePlatformOf("iosapp"), null);
    assert.equal(mobilePlatformOf("api"), null);
  });

  it("keeps ordinary services in order, one row each", () => {
    assert.deepEqual(names(groupRunServices(of("api", "web", "panel"))), ["api", "web", "panel"]);
  });

  it("merges iOS and Android into one row at the first mobile service, iOS first", () => {
    const rows = groupRunServices(of("api", "flutter-android", "web", "flutter-ios"));
    assert.deepEqual(names(rows), ["api", "mobile:flutter-ios+flutter-android", "web"]);
  });

  it("still makes one row when only one platform exists", () => {
    assert.deepEqual(names(groupRunServices(of("api", "flutter-android"))), ["api", "mobile:flutter-android"]);
  });

  it("leaves a second service of the same app and platform as its own row", () => {
    assert.deepEqual(names(groupRunServices(of("flutter-ios", "ios-flutter", "flutter-android"))), ["mobile:flutter-ios+flutter-android", "ios-flutter"]);
  });

  it("gives every app its own row titled with the app name, in the position of its first service", () => {
    const rows = groupRunServices(of(
      "api",
      "mobile-anipurr-ios",
      "mobile-fictionpurr-android",
      "web",
      "mobile-mahopurr-ios",
      "mobile-anipurr-android",
      "mobile-fictionpurr-ios",
      "mobile-mahopurr-android"
    ));
    assert.deepEqual(names(rows), [
      "api",
      "mobile:mobile-anipurr-ios+mobile-anipurr-android",
      "mobile:mobile-fictionpurr-ios+mobile-fictionpurr-android",
      "web",
      "mobile:mobile-mahopurr-ios+mobile-mahopurr-android"
    ]);
    assert.deepEqual(titles(rows), ["mobile-anipurr", "mobile-fictionpurr", "mobile-mahopurr"]);
  });

  it("titles a row with the app name wherever the platform part sits, and falls back to mobile", () => {
    assert.deepEqual(titles(groupRunServices(of("ios-dev", "mobile-ios-shop", "flutter-ios"))), ["dev", "mobile-shop", "flutter"]);
    assert.deepEqual(titles(groupRunServices(of("ios", "android"))), ["mobile"]);
  });

  it("keeps an app with a single platform as one row titled with the app name", () => {
    const rows = groupRunServices(of("mobile-mahopurr-android"));
    assert.deepEqual(names(rows), ["mobile:mobile-mahopurr-android"]);
    assert.deepEqual(titles(rows), ["mobile-mahopurr"]);
  });

  it("shows one shared end button whose text and targets follow which platform can be ended", () => {
    assert.deepEqual(planMobileStop({ ios: true, android: false }), { label: "結束 iOS", platforms: ["ios"] });
    assert.deepEqual(planMobileStop({ ios: false, android: true }), { label: "結束 Android", platforms: ["android"] });
    assert.deepEqual(planMobileStop({ ios: true, android: true }), { label: "結束全部", platforms: ["ios", "android"] });
    assert.equal(planMobileStop({ ios: false, android: false }), null);
  });

  it("uses a fixed shutdown command per platform", () => {
    const ios = simulatorShutdownCommand("ios");
    const android = simulatorShutdownCommand("android");
    assert.match(ios, /xcrun simctl shutdown booted/);
    assert.match(android, /emu kill/);
    assert.notEqual(ios, android);
    assert.equal(simulatorShutdownCommand("ios"), ios);
  });
});

describe("run service display", () => {
  it("shows purr names in camel case and leaves everything else alone", () => {
    for (const [name, shown] of [
      ["mobile-mahopurr", "mobile-mahoPurr"],
      ["web-sparkpurr", "web-sparkPurr"],
      ["desktop-mahopurr", "desktop-mahoPurr"],
      ["mobile-anipurr", "mobile-aniPurr"],
      ["mobile-poppurr", "mobile-popPurr"]
    ] as const) {
      assert.equal(displayServiceName(name), shown);
    }
    for (const name of ["purr", "api", "web", "flutter-ios"]) {
      assert.equal(displayServiceName(name), name);
    }
  });

  it("does not change how mobile services are grouped", () => {
    const rows = groupRunServices([{ name: "mobile-mahopurr-ios" }, { name: "mobile-mahopurr-android" }]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.kind === "mobile" ? rows[0].title : "", "mobile-mahopurr");
  });

  it("summarizes the state of a merged mobile row", () => {
    assert.deepEqual(
      summarizeMobileState([
        { platform: "ios", state: "stopped" },
        { platform: "android", state: "stopped" }
      ]),
      { state: "stopped", text: "未啟動" }
    );
    assert.deepEqual(
      summarizeMobileState([
        { platform: "ios", state: "running" },
        { platform: "android", state: "stopped" }
      ]),
      { state: "running", text: "iOS 執行中" }
    );
    assert.deepEqual(
      summarizeMobileState([
        { platform: "ios", state: "running" },
        { platform: "android", state: "starting" }
      ]),
      { state: "running", text: "iOS 執行中、Android 啟動中" }
    );
  });
});
