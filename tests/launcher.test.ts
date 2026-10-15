import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { platform } from "node:os";
import { describe, it } from "node:test";
import {
  DEFAULT_SHORTCUT,
  isValidAccelerator,
  isValidAppName,
  isValidTerminalChoice,
  normalizeFolderPath,
  validateMappingInput,
  type TerminalMapping
} from "@shared/launcher";
import type { Project } from "@shared/projects";
import { deleteMapping, getMapping, listMappings, saveMapping } from "@main/db/mappings-repo";
import { launchTerminal, type LaunchDeps } from "@main/launcher/launch";
import { ITERM_CLOSE_SCRIPT, ITERM_TABS_SCRIPT, SCRIPTS, buildItermCloseArgs, buildItermTabsArgs, buildOpenArgs, buildOsascriptArgs } from "@main/launcher/osascript";
import { ancestorsOf, buildLaunchTargets, resolveMapping } from "@main/launcher/resolve";
import { createTestDb } from "./helpers/db";

let nextId = 0;
const mapping = (pathPattern: string, overrides: Partial<TerminalMapping> = {}): TerminalMapping => ({
  id: (nextId += 1), pathPattern, command: "", recursive: false, terminalApp: "default", ...overrides
});

describe("path helpers", () => {
  it("lists a folder and its parents, excluding the root", () => {
    assert.deepEqual(ancestorsOf("/Users/me/Projects/api"), ["/Users/me/Projects/api", "/Users/me/Projects", "/Users/me", "/Users"]);
    assert.deepEqual(ancestorsOf("/Users/me/"), ["/Users/me", "/Users"]);
    assert.deepEqual(ancestorsOf("/"), []);
  });

  it("normalises trailing slashes", () => {
    assert.equal(normalizeFolderPath("/a/b///"), "/a/b");
    assert.equal(normalizeFolderPath("/"), "/");
  });
});

describe("resolveMapping", () => {
  it("matches an exact path, and only that folder unless recursive", () => {
    const exact = mapping("/Users/me/api", { command: "pnpm dev" });
    assert.equal(resolveMapping([exact], "/Users/me/api")?.mapping.id, exact.id);
    assert.equal(resolveMapping([exact], "/Users/me/api/src"), null);
    assert.equal(resolveMapping([exact], "/Users/me/web"), null);
  });

  it("supports * and ? patterns that stay inside one folder level", () => {
    const projects = mapping("/Users/me/Projects/*");
    assert.ok(resolveMapping([projects], "/Users/me/Projects/api"));
    assert.equal(resolveMapping([projects], "/Users/me/Projects/api/src"), null);
    assert.equal(resolveMapping([projects], "/Users/me/Projects"), null);
    assert.ok(resolveMapping([mapping("/Users/me/app-?")], "/Users/me/app-1"));
    assert.equal(resolveMapping([mapping("/Users/me/app-?")], "/Users/me/app-12"), null);
  });

  it("recursive mappings also cover sub-folders at any depth", () => {
    const recursive = mapping("/Users/me/Projects/*", { recursive: true });
    const hit = resolveMapping([recursive], "/Users/me/Projects/api/src/deep");
    assert.ok(hit);
    assert.equal(hit.distance, 2);
    assert.equal(resolveMapping([recursive], "/Users/me/Other/api"), null);
  });

  it("prefers the closest match, then exact over wildcard, then more specific text", () => {
    const wide = mapping("/Users/me/Projects/*", { command: "wide", recursive: true });
    const exact = mapping("/Users/me/Projects/api", { command: "exact" });
    const parent = mapping("/Users/me/Projects/api", { command: "parent", recursive: true });
    const deepWildcard = mapping("/Users/me/*/api", { command: "wildcard" });

    assert.equal(resolveMapping([wide, exact], "/Users/me/Projects/api")?.mapping.command, "exact");
    assert.equal(resolveMapping([exact, wide], "/Users/me/Projects/api")?.mapping.command, "exact", "order does not matter");
    assert.equal(resolveMapping([wide, parent], "/Users/me/Projects/api/src")?.mapping.command, "parent", "closest ancestor wins");
    assert.equal(resolveMapping([deepWildcard, exact], "/Users/me/Projects/api")?.mapping.command, "exact");
    // 兩條都是萬用符號、離得一樣近：固定的字元越多越具體（19 對 14 個）。
    const literalWins = resolveMapping([mapping("/Users/me/*/api", { command: "fewer" }), mapping("/Users/*/Projects/api", { command: "more" })], "/Users/me/Projects/api");
    assert.equal(literalWins?.mapping.command, "more", "more fixed characters is more specific");
  });

  it("falls back to the earliest mapping when everything else is equal, and tolerates trailing slashes", () => {
    const first = mapping("/Users/me/x");
    const second = mapping("/Users/me/x/");
    assert.equal(resolveMapping([second, first], "/Users/me/x/")?.mapping.id, first.id);
  });

  it("returns null for the root and for no mappings", () => {
    assert.equal(resolveMapping([], "/Users/me"), null);
    assert.equal(resolveMapping([mapping("/*")], "/"), null);
  });
});

describe("buildLaunchTargets", () => {
  const project = (name: string, localPath: string | null, enabled = true) => ({ name, localPath, enabled }) as Project;

  it("lists projects with a local path plus exact mapped folders, each folder once", () => {
    const targets = buildLaunchTargets(
      [project("acme/api", "/Users/me/api"), project("no-path", null), project("off", "/Users/me/off", false)],
      [mapping("/Users/me/api"), mapping("/Users/me/scratch"), mapping("/Users/me/Projects/*")]
    );
    assert.deepEqual(targets, [
      { label: "acme/api", folder: "/Users/me/api" },
      { label: "scratch", folder: "/Users/me/scratch" }
    ]);
  });
});

describe("osascript arguments", () => {
  const hostile = `/Users/me/it's a "dir" $HOME \`x\` 中文; rm -rf /`;

  it("keeps the AppleScript constant and passes folder and command only as arguments", () => {
    for (const app of ["terminal", "iterm"] as const) {
      const args = buildOsascriptArgs(app, hostile, 'echo "hi" && pnpm dev');
      const scriptLines = args.slice(0, -3).filter((_, index) => index % 2 === 1);
      assert.deepEqual(scriptLines, [...SCRIPTS[app]]);
      assert.ok(scriptLines.every((line) => !line.includes("rm -rf") && !line.includes("$HOME")));
      assert.deepEqual(args.slice(-3), ["--", hostile, 'echo "hi" && pnpm dev']);
    }
  });

  it("opens iTerm2 tabs with a constant script and every folder, name and command only as arguments", () => {
    const tabs = [
      { dir: hostile, name: 'api "x"', command: "env DEV_PORT=1 pnpm dev; rm -rf /" },
      { dir: "/Users/me/web", name: "web", command: "pnpm dev $(whoami)" }
    ];
    const args = buildItermTabsArgs(tabs);
    const scriptLines = args.slice(0, args.indexOf("--")).filter((_, index) => index % 2 === 1);
    assert.deepEqual(scriptLines, [...ITERM_TABS_SCRIPT]);
    assert.ok(scriptLines.every((line) => !line.includes("rm -rf") && !line.includes("whoami") && !line.includes("DEV_PORT")));
    assert.deepEqual(args.slice(args.indexOf("--")), ["--", ...tabs.flatMap((tab) => [tab.dir, tab.name, tab.command])]);
    assert.ok(ITERM_TABS_SCRIPT.some((line) => line.includes("com.googlecode.iterm2")));
  });

  it("closes iTerm2 sessions with a constant script and names only as arguments", () => {
    const names = ['gitnrun p:1 web"; do shell script "rm -rf /"', "gitnrun p:2 api"];
    const args = buildItermCloseArgs(names);
    const scriptLines = args.slice(0, args.indexOf("--")).filter((_, index) => index % 2 === 1);
    assert.deepEqual(scriptLines, [...ITERM_CLOSE_SCRIPT]);
    assert.ok(scriptLines.every((line) => !line.includes("rm -rf") && !line.includes("gitnrun p:")));
    assert.deepEqual(args.slice(args.indexOf("--")), ["--", ...names]);
  });

  it("targets the apps by bundle id, so a renamed app still works", () => {
    assert.ok(SCRIPTS.terminal.some((line) => line.includes("com.apple.Terminal")));
    assert.ok(SCRIPTS.iterm.some((line) => line.includes("com.googlecode.iterm2")));
  });

  it("builds `open -a` arguments for other terminals without a shell", () => {
    assert.deepEqual(buildOpenArgs("Warp", "/Users/me/api"), ["-a", "Warp", "/Users/me/api"]);
  });

  // AppleScript 的 `quoted form of` 是純文字運算，不會開啟任何 App，可以直接驗證引號處理。
  it("AppleScript's own quoting turns even a hostile folder name into one safe shell word", { skip: platform() !== "darwin" }, () => {
    const quoted = execFileSync(
      "/usr/bin/osascript",
      ["-e", "on run argv", "-e", "return quoted form of item 1 of argv", "-e", "end run", "--", hostile],
      { encoding: "utf8" }
    ).trim();
    const echoed = execFileSync("/bin/sh", ["-c", `printf '%s' ${quoted}`], { encoding: "utf8" });
    assert.equal(echoed, hostile, "the shell receives the folder name verbatim, as a single argument");
  });
});

describe("launchTerminal", () => {
  const setup = (overrides: Partial<LaunchDeps> & { list?: TerminalMapping[]; kinds?: Record<string, "dir" | "file" | "missing"> } = {}) => {
    const execs: Array<{ file: string; args: readonly string[] }> = [];
    const deps: LaunchDeps = {
      mappings: () => overrides.list ?? [],
      defaultTerminal: () => "terminal",
      available: () => ({ terminal: true, iterm: true }),
      inspect: async (path) => overrides.kinds?.[path] ?? "dir",
      exec: async (file, args) => {
        execs.push({ file, args });
        return { code: 0, stderr: "" };
      },
      ...overrides
    };
    return { deps, execs };
  };

  it("opens Terminal in the folder and runs the mapped command", async () => {
    const t = setup({ list: [mapping("/Users/me/api", { command: "pnpm dev" })] });
    const result = await launchTerminal(t.deps, "/Users/me/api");

    assert.ok(result.ok);
    assert.equal(result.command, "pnpm dev");
    assert.equal(result.folder, "/Users/me/api");
    assert.equal(t.execs[0]?.file, "/usr/bin/osascript");
    assert.deepEqual(t.execs[0]?.args.slice(-3), ["--", "/Users/me/api", "pnpm dev"]);
  });

  it("opens a plain terminal when nothing is mapped", async () => {
    const t = setup();
    const result = await launchTerminal(t.deps, "/Users/me/unmapped");
    assert.ok(result.ok);
    assert.equal(result.command, null);
    assert.equal(result.mappingId, null);
    assert.deepEqual(t.execs[0]?.args.slice(-2), ["/Users/me/unmapped", ""]);
  });

  it("uses the mapping's own terminal over the default, and the default otherwise", async () => {
    const iterm = setup({ list: [mapping("/a", { command: "x", terminalApp: "iterm" })] });
    await launchTerminal(iterm.deps, "/a");
    assert.ok(iterm.execs[0]?.args.some((arg) => arg.includes("com.googlecode.iterm2")));

    const dflt = setup({ defaultTerminal: () => "iterm", list: [mapping("/a", { command: "x" })] });
    await launchTerminal(dflt.deps, "/a");
    assert.ok(dflt.execs[0]?.args.some((arg) => arg.includes("com.googlecode.iterm2")));
  });

  it("opens other terminals in the folder only, and says no command was run", async () => {
    const t = setup({ list: [mapping("/a", { command: "pnpm dev", terminalApp: "Warp" })] });
    const result = await launchTerminal(t.deps, "/a");

    assert.ok(result.ok);
    assert.equal(result.command, null, "it must not claim to have run the command");
    assert.equal(result.app, "Warp");
    assert.deepEqual(t.execs[0], { file: "/usr/bin/open", args: ["-a", "Warp", "/a"] });
  });

  it("refuses relative paths, missing folders and files, without launching anything", async () => {
    const t = setup({ kinds: { "/gone": "missing", "/file.txt": "file" } });
    for (const [path, reason] of [["relative/dir", "not-absolute"], ["", "not-absolute"], ["/gone", "missing"], ["/file.txt", "not-directory"], ["/a\0b", "not-absolute"]] as const) {
      const result = await launchTerminal(t.deps, path);
      assert.ok(!result.ok && result.reason === reason, path);
    }
    assert.equal(t.execs.length, 0);
  });

  it("reports a missing iTerm2 rather than silently using something else", async () => {
    const t = setup({ available: () => ({ terminal: true, iterm: false }), list: [mapping("/a", { terminalApp: "iterm" })] });
    const result = await launchTerminal(t.deps, "/a");
    assert.ok(!result.ok && result.reason === "app-missing");
    assert.equal(t.execs.length, 0);
  });

  it("explains the macOS Automation permission when it was denied", async () => {
    const t = setup({ exec: async () => ({ code: 1, stderr: "execution error: Not authorized to send Apple events to Terminal. (-1743)" }) });
    const result = await launchTerminal(t.deps, "/a");
    assert.ok(!result.ok && result.reason === "permission-denied");
    assert.match(result.message, /自動化/);
  });

  it("reports other failures without echoing secrets from the error text", async () => {
    const token = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    const t = setup({ exec: async () => ({ code: 1, stderr: `boom ${token}` }) });
    const result = await launchTerminal(t.deps, "/a");
    assert.ok(!result.ok && result.reason === "failed");
    assert.ok(!result.message.includes(token));
  });

  it("rejects a mapping with a malformed terminal name instead of passing it to `open`", async () => {
    const t = setup({ list: [mapping("/a", { terminalApp: "../../bin/evil" })] });
    const result = await launchTerminal(t.deps, "/a");
    assert.ok(!result.ok);
    assert.equal(t.execs.length, 0);
  });
});

describe("validateMappingInput", () => {
  const ok = { pathPattern: "/Users/me/Projects/*", command: "pnpm dev", recursive: true, terminalApp: "default" };

  it("accepts a good mapping and trims whitespace and trailing slashes", () => {
    const result = validateMappingInput({ ...ok, pathPattern: " /Users/me/Projects/* ", command: "  pnpm dev  " });
    assert.ok(result.ok);
    assert.deepEqual(result.value, ok);
    assert.equal(validateMappingInput({ ...ok, pathPattern: "/Users/me/api/" }).ok && (validateMappingInput({ ...ok, pathPattern: "/Users/me/api/" }) as { value: { pathPattern: string } }).value.pathPattern, "/Users/me/api");
  });

  it("allows an empty command (just open a terminal)", () => {
    assert.ok(validateMappingInput({ ...ok, command: "" }).ok);
  });

  it("rejects relative paths, traversal, control characters and multi-line commands", () => {
    for (const bad of [
      { ...ok, pathPattern: "Users/me" },
      { ...ok, pathPattern: "" },
      { ...ok, pathPattern: "/Users/../etc" },
      { ...ok, pathPattern: "/a\nb" },
      { ...ok, command: "echo 1\necho 2" },
      { ...ok, command: "x".repeat(8193) },
      { ...ok, recursive: "yes" },
      { ...ok, terminalApp: "../x" },
      null, "x", []
    ]) {
      assert.equal(validateMappingInput(bad).ok, false, JSON.stringify(bad));
    }
  });

  it("checks terminal names", () => {
    for (const good of ["default", "terminal", "iterm", "Warp", "Ghostty", "My Terminal 2"]) {
      assert.equal(isValidTerminalChoice(good), true, good);
    }
    for (const bad of ["", "../x", "a/b", "a;b", "-a", ".hidden", "x".repeat(61), "a..b"]) {
      assert.equal(isValidTerminalChoice(bad), false, bad);
    }
    assert.equal(isValidAppName("iTerm"), true);
  });
});

describe("isValidAccelerator", () => {
  it("accepts modifier + key combinations", () => {
    for (const good of [DEFAULT_SHORTCUT, "Cmd+Shift+T", "Ctrl+Alt+F5", "Command+Option+/", "CommandOrControl+Shift+Space", "Shift++", "Alt+1"]) {
      assert.equal(isValidAccelerator(good), true, good);
    }
  });

  it("rejects lone keys, missing keys, unknown or repeated modifiers and junk", () => {
    for (const bad of ["T", "F5", "Cmd", "Cmd+", "Cmd+Shift", "Cmd+Cmd+T", "Hyper+T", "Cmd+Shift+TT", "Cmd+F25", "", "Cmd + T", "Cmd+Shift+T+U", 5, null]) {
      assert.equal(isValidAccelerator(bad), false, String(bad));
    }
  });
});

describe("terminal mappings repo", () => {
  it("saves, updates by path, lists and deletes", () => {
    const db = createTestDb();
    const first = saveMapping(db, { pathPattern: "/a", command: "one", recursive: false, terminalApp: "default" }, 1);
    const again = saveMapping(db, { pathPattern: "/a", command: "two", recursive: true, terminalApp: "iterm" }, 2);
    saveMapping(db, { pathPattern: "/b/*", command: "", recursive: false, terminalApp: "default" }, 3);

    assert.equal(again.id, first.id, "same path updates in place");
    assert.deepEqual(getMapping(db, first.id), { id: first.id, pathPattern: "/a", command: "two", recursive: true, terminalApp: "iterm" });
    assert.deepEqual(listMappings(db).map((entry) => entry.pathPattern), ["/a", "/b/*"]);

    assert.equal(deleteMapping(db, first.id), true);
    assert.equal(deleteMapping(db, first.id), false);
    assert.equal(listMappings(db).length, 1);
  });
});
