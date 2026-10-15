import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SHORTCUT, type LaunchResult } from "@shared/launcher";
import { addProject } from "@main/db/projects-repo";
import { UserFacingError } from "@main/errors";
import { createLauncherHandlers } from "@main/launcher/handlers";
import { PROTOCOL_SCHEME, parseLaunchUrl } from "@main/launcher/protocol";
import { LAUNCHER_KEYS, readLauncherSettings } from "@main/launcher/settings";
import { createShortcutManager, type ShortcutApi } from "@main/launcher/shortcut";
import { setSetting } from "@main/db/settings-repo";
import { createTestDb } from "./helpers/db";

const fakeShortcutApi = (taken: Set<string> = new Set()) => {
  const registered = new Map<string, () => void>();
  const api: ShortcutApi = {
    register: async (accelerator, callback) => {
      if (taken.has(accelerator)) return false;
      registered.set(accelerator, callback);
      return true;
    },
    unregister: async (accelerator) => {
      registered.delete(accelerator);
    }
  };
  return { api, registered, taken };
};

describe("shortcut manager", () => {
  it("registers a shortcut and fires the callback", async () => {
    const fake = fakeShortcutApi();
    let fired = 0;
    const manager = createShortcutManager(fake.api, () => void (fired += 1));

    assert.equal(await manager.apply(DEFAULT_SHORTCUT), true);
    assert.equal(manager.current(), DEFAULT_SHORTCUT);
    fake.registered.get(DEFAULT_SHORTCUT)?.();
    assert.equal(fired, 1);
  });

  it("switches to a new shortcut and releases the old one", async () => {
    const fake = fakeShortcutApi();
    const manager = createShortcutManager(fake.api, () => undefined);
    await manager.apply("Cmd+Shift+T");
    assert.equal(await manager.apply("Cmd+Shift+L"), true);
    assert.deepEqual([...fake.registered.keys()], ["Cmd+Shift+L"]);
  });

  it("keeps the working shortcut when the new one is taken by another app", async () => {
    const fake = fakeShortcutApi(new Set(["Cmd+Shift+L"]));
    const manager = createShortcutManager(fake.api, () => undefined);
    await manager.apply("Cmd+Shift+T");

    assert.equal(await manager.apply("Cmd+Shift+L"), false);
    assert.equal(manager.current(), "Cmd+Shift+T");
    assert.deepEqual([...fake.registered.keys()], ["Cmd+Shift+T"], "the old shortcut still works");
  });

  it("rejects malformed accelerators without touching what is registered", async () => {
    const fake = fakeShortcutApi();
    const manager = createShortcutManager(fake.api, () => undefined);
    await manager.apply("Cmd+Shift+T");
    for (const bad of ["T", "Cmd+", "nonsense", ""]) {
      assert.equal(await manager.apply(bad), false, bad);
    }
    assert.equal(manager.current(), "Cmd+Shift+T");
  });

  it("treats a throwing register as a failed registration", async () => {
    const manager = createShortcutManager(
      { register: async () => { throw new Error("bad accelerator"); }, unregister: async () => undefined },
      () => undefined
    );
    assert.equal(await manager.apply("Cmd+Shift+T"), false);
    assert.equal(manager.current(), null);
  });

  it("can be disabled and disposed", async () => {
    const fake = fakeShortcutApi();
    const manager = createShortcutManager(fake.api, () => undefined);
    await manager.apply("Cmd+Shift+T");
    assert.equal(await manager.apply(null), true);
    assert.equal(fake.registered.size, 0);
    assert.equal(manager.current(), null);

    await manager.apply("Cmd+Shift+T");
    await manager.dispose();
    assert.equal(fake.registered.size, 0);
  });

  it("runs overlapping changes one after another, so the last request wins and nothing leaks", async () => {
    const fake = fakeShortcutApi();
    const manager = createShortcutManager(
      {
        register: async (accelerator, callback) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return fake.api.register(accelerator, callback);
        },
        unregister: fake.api.unregister
      },
      () => undefined
    );
    const results = await Promise.all([manager.apply("Cmd+Shift+A"), manager.apply("Cmd+Shift+B"), manager.apply("Cmd+Shift+C")]);
    assert.deepEqual(results, [true, true, true]);
    assert.equal(manager.current(), "Cmd+Shift+C");
    assert.deepEqual([...fake.registered.keys()], ["Cmd+Shift+C"], "only the last one stays registered");
  });
});

describe("parseLaunchUrl", () => {
  const url = (path: string) => `${PROTOCOL_SCHEME}://launch?path=${encodeURIComponent(path)}`;

  it("accepts the one supported shape", () => {
    assert.deepEqual(parseLaunchUrl(url("/Users/me/my project")), { ok: true, folder: "/Users/me/my project" });
    assert.deepEqual(parseLaunchUrl("gitnrun://launch/?path=%2FUsers%2Fme"), { ok: true, folder: "/Users/me" });
  });

  it("rejects everything else: other actions, extra parameters, relative or odd paths, other schemes", () => {
    const retiredScheme = ["push", "watch"].join("");
    for (const bad of [
      `${retiredScheme}://launch?path=%2Fa`,
      "", "garbage", "https://launch?path=/a", "gitnrun://run?path=/a", "gitnrun://launch", "gitnrun://launch?path=",
      "gitnrun://launch?path=relative", "gitnrun://launch?path=/a&path=/b", "gitnrun://launch?path=/a&cmd=rm",
      "gitnrun://launch?cmd=rm", "gitnrun://launch/extra?path=/a", "gitnrun://user:pw@launch?path=/a",
      "gitnrun://launch?path=/a#frag", "gitnrun://launch?path=%2Fa%00b", "gitnrun://launch?path=%2Fa%0Ab",
      `gitnrun://launch?path=${encodeURIComponent("/" + "a".repeat(5000))}`
    ]) {
      assert.deepEqual(parseLaunchUrl(bad), { ok: false }, bad.slice(0, 60));
    }
  });
});

describe("launcher settings", () => {
  it("defaults, and recovers from corrupt stored values", () => {
    const db = createTestDb();
    assert.deepEqual(readLauncherSettings(db), { shortcut: DEFAULT_SHORTCUT, defaultTerminal: "terminal", selectedProjectId: null });
    assert.deepEqual(readLauncherSettings(db, "iterm"), { shortcut: DEFAULT_SHORTCUT, defaultTerminal: "iterm", selectedProjectId: null });

    setSetting(db, LAUNCHER_KEYS.shortcut, "not a shortcut");
    setSetting(db, LAUNCHER_KEYS.defaultTerminal, "../../x");
    setSetting(db, LAUNCHER_KEYS.selectedProjectId, "7");
    assert.deepEqual(readLauncherSettings(db), { shortcut: DEFAULT_SHORTCUT, defaultTerminal: "terminal", selectedProjectId: null });
    assert.deepEqual(readLauncherSettings(db, "iterm"), { shortcut: DEFAULT_SHORTCUT, defaultTerminal: "iterm", selectedProjectId: null });

    setSetting(db, LAUNCHER_KEYS.shortcut, null);
    assert.equal(readLauncherSettings(db).shortcut, null, "null means 'no shortcut' and is kept");
  });
});

describe("launcher handlers", () => {
  const setup = async (taken: Set<string> = new Set()) => {
    const db = createTestDb();
    const fake = fakeShortcutApi(taken);
    const shortcuts = createShortcutManager(fake.api, () => undefined);
    await shortcuts.apply(DEFAULT_SHORTCUT);
    const launched: string[] = [];
    const state = { changed: 0 };
    const handlers = createLauncherHandlers({
      db,
      shortcuts,
      launch: async (folder): Promise<LaunchResult> => {
        launched.push(folder);
        return { ok: true, folder, app: "Terminal", command: null, mappingId: null };
      },
      availability: () => ({ terminal: true, iterm: false }),
      onConfigChanged: () => void (state.changed += 1)
    });
    const project = (localPath: string | null) => {
      const added = addProject(db, {
        owner: "acme", repo: `r${Math.random().toString(36).slice(2, 8)}`, name: "p", localPath,
        branchFilter: ["*"], pollIntervalSec: 30, mode: "poll", enabled: true, aiEnabled: false
      });
      return added;
    };
    return { db, handlers, launched, state, shortcuts, project, fake };
  };

  it("saves, lists and deletes mappings, scheduling a backup each time", async () => {
    const t = await setup();
    const saved = t.handlers.saveMapping({ pathPattern: "/Users/me/api/", command: " pnpm dev ", recursive: false, terminalApp: "default" });
    assert.equal(saved.pathPattern, "/Users/me/api");
    assert.equal(saved.command, "pnpm dev");
    assert.equal(t.handlers.listMappings().length, 1);

    t.handlers.deleteMapping(saved.id);
    t.handlers.deleteMapping(saved.id);
    assert.equal(t.handlers.listMappings().length, 0);
    assert.equal(t.state.changed, 2, "deleting something that is gone changes nothing");
  });

  it("explains why a mapping was rejected", async () => {
    const t = await setup();
    assert.throws(
      () => t.handlers.saveMapping({ pathPattern: "relative", command: "x", recursive: false, terminalApp: "default" }),
      (error) => error instanceof UserFacingError && error.message.includes("絕對路徑")
    );
    assert.equal(t.handlers.listMappings().length, 0);
  });

  it("launches a folder, or a project through its registered path", async () => {
    const t = await setup();
    await t.handlers.launchFolder("/Users/me/api");
    await t.handlers.launchProject(t.project("/Users/me/web").id);
    assert.deepEqual(t.launched, ["/Users/me/api", "/Users/me/web"]);

    const noPath = await t.handlers.launchProject(t.project(null).id);
    assert.ok(!noPath.ok);
    await assert.rejects(t.handlers.launchProject(999), UserFacingError);
    assert.equal(t.launched.length, 2);
  });

  it("changes the shortcut only when it can actually be registered", async () => {
    const t = await setup(new Set(["Cmd+Shift+L"]));
    assert.equal(t.handlers.getSettings().shortcutRegistered, true);

    const updated = await t.handlers.saveSettings({ shortcut: "Cmd+Shift+K" });
    assert.equal(updated.shortcut, "Cmd+Shift+K");
    assert.equal(updated.shortcutRegistered, true);

    await assert.rejects(t.handlers.saveSettings({ shortcut: "Cmd+Shift+L" }), (error) => error instanceof UserFacingError && error.message.includes("已被其他程式使用"));
    assert.equal(t.handlers.getSettings().shortcut, "Cmd+Shift+K", "the previous, working shortcut is kept");
    assert.equal(t.shortcuts.current(), "Cmd+Shift+K");

    await assert.rejects(t.handlers.saveSettings({ shortcut: "T" }), UserFacingError);
    assert.equal((await t.handlers.saveSettings({ shortcut: null })).shortcut, null);
    assert.equal(t.shortcuts.current(), null);
  });

  it("validates the default terminal and the selected project", async () => {
    const t = await setup();
    assert.equal((await t.handlers.saveSettings({ defaultTerminal: "iterm" })).defaultTerminal, "iterm");
    assert.equal((await t.handlers.saveSettings({ defaultTerminal: "Warp" })).defaultTerminal, "Warp");
    for (const bad of ["../x", "", "default"]) {
      await assert.rejects(t.handlers.saveSettings({ defaultTerminal: bad }), UserFacingError, bad);
    }

    const project = t.project("/Users/me/api");
    assert.equal((await t.handlers.saveSettings({ selectedProjectId: project.id })).selectedProjectId, project.id);
    await assert.rejects(t.handlers.saveSettings({ selectedProjectId: 999 }), UserFacingError);
    assert.equal((await t.handlers.saveSettings({ selectedProjectId: null })).selectedProjectId, null);
  });

  it("prefers iTerm2 when it is installed and no default terminal has been saved", async () => {
    const t = await setup();
    assert.equal(t.handlers.getSettings().defaultTerminal, "terminal");

    const db = createTestDb();
    const fake = fakeShortcutApi();
    const shortcuts = createShortcutManager(fake.api, () => undefined);
    await shortcuts.apply(DEFAULT_SHORTCUT);
    const handlers = createLauncherHandlers({
      db,
      shortcuts,
      launch: async (folder): Promise<LaunchResult> => ({ ok: true, folder, app: "iTerm2", command: null, mappingId: null }),
      availability: () => ({ terminal: true, iterm: true }),
      onConfigChanged: () => undefined
    });
    assert.equal(handlers.getSettings().defaultTerminal, "iterm");
  });

  it("a rejected change does not partially apply", async () => {
    const t = await setup(new Set(["Cmd+Shift+L"]));
    await assert.rejects(t.handlers.saveSettings({ defaultTerminal: "iterm", shortcut: "Cmd+Shift+L" }));
    assert.equal(t.handlers.getSettings().defaultTerminal, "terminal");
  });

  it("reports which terminals are installed", async () => {
    assert.deepEqual((await setup()).handlers.availability(), { terminal: true, iterm: false });
  });
});

import { createExternalOpenGate, type ExternalRequest } from "@main/launcher/external";

describe("external open gate", () => {
  const url = (value: string): ExternalRequest => ({ kind: "url", value });
  const file = (value: string): ExternalRequest => ({ kind: "file", value });

  it("holds early requests until a handler is attached, then delivers them in order exactly once", () => {
    const gate = createExternalOpenGate();
    gate.push(url("gitnrun://launch?path=%2Fa"));
    gate.push(file("/b"));

    const seen: ExternalRequest[] = [];
    gate.attach((request) => seen.push(request));
    assert.deepEqual(seen, [url("gitnrun://launch?path=%2Fa"), file("/b")]);

    gate.push(file("/c"));
    assert.deepEqual(seen.at(-1), file("/c"));
    assert.equal(seen.length, 3);
  });

  it("does not grow without bound before it is ready", () => {
    const gate = createExternalOpenGate();
    for (let i = 0; i < 100; i += 1) gate.push(file(`/f${i}`));
    const seen: ExternalRequest[] = [];
    gate.attach((request) => seen.push(request));
    assert.equal(seen.length, 20);
    assert.deepEqual(seen[0], file("/f0"));
  });
});
