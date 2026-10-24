import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createSidecarServer, type SidecarServer } from "@main/sidecar/server";
import { CORE_EVENT, HOST_REQUEST, type Frame } from "@main/sidecar/protocol";
import { connectFakeHost, hostInfo, type FakeHost } from "./helpers/fake-host";

const TOKEN = "t".repeat(32);

describe("sidecar server", () => {
  let dir: string;
  let socketPath: string;
  let server: SidecarServer;
  let hosts: FakeHost[];
  let events: Array<[string, unknown]>;
  let connectedCount: number;
  let invoked: Array<[string, readonly unknown[]]>;
  let logs: string[];

  const start = async (invoke: (channel: string, args: readonly unknown[]) => Promise<unknown> = async () => "ok"): Promise<void> => {
    server = createSidecarServer({
      socketPath,
      token: TOKEN,
      invoke: (channel, args) => {
        invoked.push([channel, args]);
        return invoke(channel, args);
      },
      onConnected: () => {
        connectedCount += 1;
      },
      onEvent: (method, payload) => events.push([method, payload]),
      log: (message) => logs.push(message),
      helloTimeoutMs: 300
    });
    await server.listen();
  };

  const connect = async (): Promise<FakeHost> => {
    const host = await connectFakeHost(socketPath);
    hosts.push(host);
    return host;
  };

  const handshake = async (host: FakeHost, id = 1): Promise<Frame> => {
    host.send({ k: "req", id, m: HOST_REQUEST.hello, p: hostInfo(TOKEN) });
    return host.waitFor((frame) => frame.k === "res" && frame.id === id);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gnr-sc-"));
    socketPath = join(dir, "run", "core.sock");
    hosts = [];
    events = [];
    connectedCount = 0;
    invoked = [];
    logs = [];
  });

  afterEach(async () => {
    for (const host of hosts) host.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the socket directory as 0700 and the socket as 0600", async () => {
    await start();
    assert.equal(statSync(join(dir, "run")).mode & 0o777, 0o700);
    assert.equal(statSync(socketPath).mode & 0o777, 0o600);
  });

  it("rejects a wrong token and a wrong protocol version, then drops the connection", async () => {
    await start();
    const badToken = await connect();
    badToken.send({ k: "req", id: 1, m: HOST_REQUEST.hello, p: hostInfo("x".repeat(32)) });
    const reply = await badToken.waitFor((frame) => frame.k === "res");
    assert.equal(reply.k === "res" && reply.ok, false);
    await badToken.closed;

    const badVersion = await connect();
    badVersion.send({ k: "req", id: 1, m: HOST_REQUEST.hello, p: hostInfo(TOKEN, { v: 99 }) });
    await badVersion.waitFor((frame) => frame.k === "res" && !frame.ok);
    await badVersion.closed;

    assert.equal(connectedCount, 0);
    assert.equal(server.connected(), false);
    assert.ok(!logs.join("\n").includes(TOKEN));
  });

  it("drops a connection that sends anything before hello, or never says hello", async () => {
    await start();
    const early = await connect();
    early.send({ k: "req", id: 1, m: HOST_REQUEST.ipcInvoke, p: { channel: "app:info", args: [] } });
    await early.closed;
    assert.equal(invoked.length, 0);

    const silent = await connect();
    await silent.closed;
  });

  it("forwards a valid invoke to the validator-backed handler and wraps the result", async () => {
    await start(async (channel) => (channel === "a" ? undefined : channel === "n" ? null : { x: 1 }));
    const host = await connect();
    await handshake(host);

    host.send({ k: "req", id: 2, m: HOST_REQUEST.ipcInvoke, p: { channel: "a", args: [1, "two"] } });
    host.send({ k: "req", id: 3, m: HOST_REQUEST.ipcInvoke, p: { channel: "n", args: [] } });
    host.send({ k: "req", id: 4, m: HOST_REQUEST.ipcInvoke, p: { channel: "o", args: [] } });
    const [undef, nul, obj] = await Promise.all([2, 3, 4].map((id) => host.waitFor((frame) => frame.k === "res" && frame.id === id)));

    assert.deepEqual(invoked[0], ["a", [1, "two"]]);
    assert.deepEqual(undef, { k: "res", id: 2, ok: true, v: {} });
    assert.deepEqual(nul, { k: "res", id: 3, ok: true, v: { value: null } });
    assert.deepEqual(obj, { k: "res", id: 4, ok: true, v: { value: { x: 1 } } });
  });

  it("returns only name and message when the handler throws, and rejects malformed invokes", async () => {
    await start(async () => {
      const error = new Error("ipc: unknown channel");
      error.name = "SomeError";
      throw error;
    });
    const host = await connect();
    await handshake(host);

    host.send({ k: "req", id: 2, m: HOST_REQUEST.ipcInvoke, p: { channel: "nope", args: [] } });
    host.send({ k: "req", id: 3, m: HOST_REQUEST.ipcInvoke, p: { channel: 5, args: [] } });
    const thrown = await host.waitFor((frame) => frame.k === "res" && frame.id === 2);
    const malformed = await host.waitFor((frame) => frame.k === "res" && frame.id === 3);

    assert.deepEqual(thrown, { k: "res", id: 2, ok: false, e: { name: "SomeError", message: "ipc: unknown channel" } });
    assert.equal(malformed.k === "res" && malformed.ok, false);
    assert.equal(invoked.length, 1);
  });

  it("answers an oversized result with an error instead of an oversized frame", async () => {
    await start(async () => "x".repeat(9 * 1024 * 1024));
    const host = await connect();
    await handshake(host);
    host.send({ k: "req", id: 2, m: HOST_REQUEST.ipcInvoke, p: { channel: "big", args: [] } });
    const reply = await host.waitFor((frame) => frame.k === "res" && frame.id === 2);
    assert.equal(reply.k === "res" && reply.ok, false);
    assert.equal(server.connected(), true);
  });

  it("pushes events to the host and delivers host events to the core", async () => {
    await start();
    const host = await connect();
    await handshake(host);

    server.push("monitor:changed", { n: 1 });
    const pushed = await host.waitFor((frame) => frame.k === "evt" && frame.m === CORE_EVENT.push);
    assert.deepEqual(pushed, { k: "evt", m: CORE_EVENT.push, p: { channel: "monitor:changed", payload: { n: 1 } } });

    host.send({ k: "evt", m: "shortcut", p: { accelerator: "A" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(events, [["shortcut", { accelerator: "A" }]]);
  });

  it("correlates native requests with responses, including failures", async () => {
    await start();
    const host = await connect();
    await handshake(host);

    const first = server.request("native.test", { a: 1 });
    const second = server.request("native.fail");
    const reqs = await Promise.all([
      host.waitFor((frame) => frame.k === "req" && frame.m === "native.test"),
      host.waitFor((frame) => frame.k === "req" && frame.m === "native.fail")
    ]);
    // 故意亂序回應。
    host.send({ k: "res", id: (reqs[1] as { id: number }).id, ok: false, e: { name: "Boom", message: "bad" } });
    host.send({ k: "res", id: (reqs[0] as { id: number }).id, ok: true, v: 42 });

    assert.equal(await first, 42);
    await assert.rejects(second, (error: Error) => error.name === "Boom" && error.message === "bad");
  });

  it("sends a cancel event and rejects with AbortError when the signal aborts", async () => {
    await start();
    const host = await connect();
    await handshake(host);

    const controller = new AbortController();
    const pending = server.request("native.dialog.confirm", { title: "t" }, { signal: controller.signal });
    const req = (await host.waitFor((frame) => frame.k === "req" && frame.m === "native.dialog.confirm")) as { id: number };
    controller.abort();

    await assert.rejects(pending, (error: Error) => error.name === "AbortError");
    const cancel = await host.waitFor((frame) => frame.k === "evt" && frame.m === CORE_EVENT.cancel);
    assert.deepEqual(cancel, { k: "evt", m: CORE_EVENT.cancel, p: { id: req.id } });
    await assert.rejects(server.request("x", undefined, { signal: controller.signal }), (error: Error) => error.name === "AbortError");
  });

  it("fails native requests when there is no host or the host disconnects", async () => {
    await start();
    await assert.rejects(server.request("native.test"), (error: Error) => error.name === "HostDisconnectedError");

    const host = await connect();
    await handshake(host);
    const pending = server.request("native.test");
    await host.waitFor((frame) => frame.k === "req");
    host.close();
    await assert.rejects(pending, (error: Error) => error.name === "HostDisconnectedError");
  });

  it("lets a new authenticated connection replace the old one", async () => {
    await start();
    const first = await connect();
    await handshake(first);
    const outcome = assert.rejects(server.request("native.test"), (error: Error) => error.name === "HostDisconnectedError");
    await first.waitFor((frame) => frame.k === "req");

    const second = await connect();
    await handshake(second);

    await outcome;
    await first.closed;
    assert.equal(server.connected(), true);
    assert.equal(connectedCount, 2);
    server.push("c", 1);
    await second.waitFor((frame) => frame.k === "evt" && frame.m === CORE_EVENT.push);
  });

  it("drops the connection on malformed or oversized input and never logs payloads", async () => {
    await start();
    const host = await connect();
    await handshake(host);
    host.socket.write("not json\n");
    await host.closed;
    assert.equal(server.connected(), false);

    const second = await connect();
    await handshake(second, 5);
    second.socket.write("x".repeat(9 * 1024 * 1024));
    await second.closed;
    assert.ok(logs.every((line) => !line.includes("secret-payload")));
  });
});
