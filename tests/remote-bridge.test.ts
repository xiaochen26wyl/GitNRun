import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { createRemoteNativeBridge, type RemoteBridge } from "@main/native/remote-bridge";
import { ENV_SOCKET, ENV_TOKEN, takeSidecarEnv } from "@main/sidecar/env";
import { EXIT_RESTART, HOST_EVENT, NATIVE } from "@main/sidecar/protocol";
import type { RequestOptions, SidecarServer } from "@main/sidecar/server";

interface Call {
  method: string;
  params: unknown;
}

const abortError = (): Error => Object.assign(new Error("aborted"), { name: "AbortError" });

/** 假的連線：記錄請求，回應由測試指定。 */
const fakeServer = (respond: (call: Call, options?: RequestOptions) => Promise<unknown>) => {
  const calls: Call[] = [];
  const pushed: Array<[string, unknown]> = [];
  let connected = true;
  const server: SidecarServer = {
    listen: async () => undefined,
    close: async () => undefined,
    connected: () => connected,
    push: (channel, payload) => void pushed.push([channel, payload]),
    event: () => undefined,
    request: (method, params, options) => {
      const call = { method, params };
      calls.push(call);
      return respond(call, options);
    }
  };
  return { server, calls, pushed, setConnected: (value: boolean) => void (connected = value) };
};

const info = { v: 1, appName: "GitNRun", appVersion: "1.2.3", platform: "darwin", dataDir: "/data/GitNRun", packaged: false };

describe("remote native bridge", () => {
  let exits: number[];
  let remote: RemoteBridge;
  let host: ReturnType<typeof fakeServer>;

  const build = (respond: (call: Call, options?: RequestOptions) => Promise<unknown> = async () => undefined): void => {
    host = fakeServer(respond);
    remote = createRemoteNativeBridge({ server: host.server, info, exit: (code) => void exits.push(code) });
  };

  beforeEach(() => {
    exits = [];
    build();
  });

  it("answers app info and data dir from the host info without a round trip", () => {
    assert.deepEqual(remote.bridge.appInfo(), { name: "GitNRun", version: "1.2.3", platform: "darwin" });
    assert.equal(remote.bridge.dataDir(), "/data/GitNRun");
    assert.equal(host.calls.length, 0);
  });

  it("relaunch exits with the restart code and exit passes its code through", () => {
    remote.bridge.relaunch();
    remote.bridge.exit(1);
    assert.deepEqual(exits, [EXIT_RESTART, 1]);
  });

  it("returns the pressed button, and cancelId when aborted or the host is gone", async () => {
    const request = { kind: "warning" as const, title: "t", message: "m", detail: "d", buttons: ["a", "b"], defaultId: 0, cancelId: 1 };
    build(async () => 0);
    assert.equal(await remote.bridge.confirm(request), 0);

    build((_call, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(abortError()))));
    const controller = new AbortController();
    const answer = remote.bridge.confirm(request, { signal: controller.signal });
    controller.abort();
    assert.equal(await answer, 1);

    build(async () => {
      throw new Error("host is not connected");
    });
    assert.equal(await remote.bridge.confirm(request), 1);
  });

  it("normalises dialog results", async () => {
    build(async (call) => (call.method === NATIVE.saveFile ? { canceled: false, filePath: "/x.json" } : { canceled: false, filePaths: ["/a", 5, "/b"] }));
    assert.deepEqual(await remote.bridge.showSaveDialog({ title: "t", defaultPath: "d", filters: [] }), { canceled: false, filePath: "/x.json" });
    assert.deepEqual(await remote.bridge.showOpenFileDialog({ title: "t", filters: [] }), { canceled: false, filePaths: ["/a", "/b"] });

    build(async () => ({ canceled: true }));
    assert.deepEqual(await remote.bridge.showSaveDialog({ title: "t", defaultPath: "d", filters: [] }), { canceled: true });
    assert.deepEqual(await remote.bridge.showOpenFileDialog({ title: "t", filters: [] }), { canceled: true, filePaths: [] });
  });

  it("runs the notification callback once when the host reports a click", () => {
    let clicks = 0;
    assert.equal(remote.bridge.notify("hi", "body", () => (clicks += 1)), true);
    const id = (host.calls[0]?.params as { id: number }).id;
    assert.ok(id > 0);

    assert.equal(remote.handleEvent(HOST_EVENT.notificationClick, { id }), true);
    remote.handleEvent(HOST_EVENT.notificationClick, { id });
    assert.equal(clicks, 1);
  });

  it("reports notifications as unsupported while disconnected", () => {
    host.setConnected(false);
    assert.equal(remote.bridge.notify("hi", "body"), false);
    assert.equal(host.calls.length, 0);
  });

  it("registers shortcuts, dispatches triggers, and reports registration failure", async () => {
    let fired = 0;
    build(async (call) => (call.params as { accelerator: string }).accelerator !== "Bad");
    assert.equal(await remote.bridge.shortcutRegister("Cmd+Shift+T", () => (fired += 1)), true);
    assert.equal(await remote.bridge.shortcutRegister("Bad", () => undefined), false);

    remote.handleEvent(HOST_EVENT.shortcut, { accelerator: "Cmd+Shift+T" });
    remote.handleEvent(HOST_EVENT.shortcut, { accelerator: "Bad" });
    assert.equal(fired, 1);

    await remote.bridge.shortcutUnregister("Cmd+Shift+T");
    remote.handleEvent(HOST_EVENT.shortcut, { accelerator: "Cmd+Shift+T" });
    assert.equal(fired, 1);
  });

  it("re-registers surviving shortcuts after the host reconnects", async () => {
    build(async () => true);
    await remote.bridge.shortcutRegister("A", () => undefined);
    host.calls.length = 0;
    await remote.restoreAfterReconnect();
    assert.deepEqual(host.calls, [{ method: NATIVE.shortcutRegister, params: { accelerator: "A" } }]);
  });

  it("maps menu selections to the right entry and forgets the menu afterwards", () => {
    const chosen: string[] = [];
    remote.bridge.popupMenu([
      { label: "one", onClick: () => chosen.push("one") },
      { label: "two", enabled: false },
      { label: "three", onClick: () => chosen.push("three") }
    ]);
    assert.deepEqual(host.calls[0]?.params, {
      items: [
        { id: 0, label: "one", enabled: true },
        { id: 1, label: "two", enabled: false },
        { id: 2, label: "three", enabled: true }
      ]
    });
    remote.handleEvent(HOST_EVENT.menuSelect, { id: 2 });
    remote.handleEvent(HOST_EVENT.menuSelect, { id: 0 });
    assert.deepEqual(chosen, ["three"]);
  });

  it("ignores malformed host events and forwards pushes", () => {
    assert.equal(remote.handleEvent(HOST_EVENT.shortcut, "nope"), false);
    assert.equal(remote.handleEvent("unknown", {}), false);
    remote.bridge.push("monitor:changed", { n: 1 });
    assert.deepEqual(host.pushed, [["monitor:changed", { n: 1 }]]);
  });

  it("does not turn failed fire-and-forget calls into unhandled rejections", async () => {
    build(async () => {
      throw new Error("host is not connected");
    });
    remote.bridge.bounceDock();
    remote.bridge.focusMainWindow();
    remote.bridge.showErrorBox("t", "c");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(host.calls.length, 3);
  });
});

describe("sidecar environment hand-off", () => {
  it("returns the values and removes them from the environment", () => {
    const env: NodeJS.ProcessEnv = { [ENV_SOCKET]: "/tmp/x/core.sock", [ENV_TOKEN]: "a".repeat(32), KEEP: "1" };
    assert.deepEqual(takeSidecarEnv(env), { socketPath: "/tmp/x/core.sock", token: "a".repeat(32) });
    assert.deepEqual(env, { KEEP: "1" });
  });

  it("removes the token even when validation fails", () => {
    const env: NodeJS.ProcessEnv = { [ENV_SOCKET]: "relative.sock", [ENV_TOKEN]: "a".repeat(32) };
    assert.throws(() => takeSidecarEnv(env));
    assert.equal(env[ENV_TOKEN], undefined);
    assert.throws(() => takeSidecarEnv({ [ENV_SOCKET]: "/tmp/s", [ENV_TOKEN]: "short" }));
  });
});
