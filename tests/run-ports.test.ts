import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { allocatePorts, probePort, readPortsFile, writePortsFile } from "@main/run/ports";

const listen = (port: number, host: string): Promise<net.Server> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ port, host }, () => resolve(server));
  });

const close = (server: net.Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

describe("allocatePorts", () => {
  it("returns distinct ports that can actually be bound afterwards", async () => {
    const ports = await allocatePorts(6);
    assert.equal(ports.length, 6);
    assert.equal(new Set(ports).size, 6);
    for (const port of ports) {
      assert.ok(port > 0 && port < 65536);
      await close(await listen(port, "127.0.0.1"));
    }
  });

  it("returns nothing when no port is needed", async () => {
    assert.deepEqual(await allocatePorts(0), []);
  });

  it("does not hand out a port that is currently in use", async () => {
    const busy = await listen(0, "127.0.0.1");
    try {
      const busyPort = (busy.address() as net.AddressInfo).port;
      const ports = await allocatePorts(8);
      assert.equal(ports.includes(busyPort), false);
    } finally {
      await close(busy);
    }
  });

  it("never hands out the ports reserved for manual starts and releases the ones it skips", async () => {
    const sequence = [5173, 5174, 41001, 5173, 41002];
    const closed: number[] = [];
    const bind = async (): Promise<{ server: net.Server; port: number }> => {
      const port = sequence.shift() as number;
      const server = { close: (callback?: () => void) => { closed.push(port); callback?.(); } } as unknown as net.Server;
      return { server, port };
    };
    assert.deepEqual(await allocatePorts(2, [], bind), [41001, 41002]);
    assert.ok([5173, 5174].every((port) => closed.includes(port)));
  });

  it("also skips the fixed ports it is told to exclude", async () => {
    const sequence = [41001, 41002, 41003];
    const bind = async (): Promise<{ server: net.Server; port: number }> => {
      const port = sequence.shift() as number;
      return { server: { close: (callback?: () => void) => callback?.() } as unknown as net.Server, port };
    };
    assert.deepEqual(await allocatePorts(2, [41001], bind), [41002, 41003]);
  });
});

describe("probePort", () => {
  it("is true while something listens on IPv4 and false after it stops", async () => {
    const server = await listen(0, "127.0.0.1");
    const port = (server.address() as net.AddressInfo).port;
    assert.equal(await probePort(port), true);
    await close(server);
    assert.equal(await probePort(port), false);
  });

  it("detects a server that only listens on ::1 (Vite and Next often do)", async (t) => {
    let server: net.Server;
    try {
      server = await listen(0, "::1");
    } catch {
      t.skip("IPv6 loopback is not available here");
      return;
    }
    try {
      assert.equal(await probePort((server.address() as net.AddressInfo).port), true);
    } finally {
      await close(server);
    }
  });
});

describe("writePortsFile", () => {
  it("writes the services with their urls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pw-ports-"));
    const ok = await writePortsFile(dir, { api: { role: "backend", port: 4001 }, web: { role: "frontend", port: 4002 } }, Date.UTC(2026, 9, 10));
    assert.equal(ok, true);
    const body = JSON.parse(await readFile(join(dir, ".dev", "ports.json"), "utf8")) as { updatedAt: string; services: Record<string, unknown> };
    assert.equal(body.updatedAt, "2026-10-10T00:00:00.000Z");
    assert.deepEqual(body.services, {
      api: { role: "backend", port: 4001, url: "http://localhost:4001" },
      web: { role: "frontend", port: 4002, url: "http://localhost:4002" }
    });
  });

  it("returns false instead of throwing when the folder cannot be written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pw-ports-"));
    const file = join(dir, "not-a-folder");
    await writeFile(file, "x");
    assert.equal(await writePortsFile(file, { api: { role: "backend", port: 1 } }, 0), false);
    assert.equal(await writePortsFile(join(dir, "missing", "deeper", "x"), { api: { role: "backend", port: 1 } }, 0), true);
  });

  it("refuses to write through a .dev symlink", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pw-ports-"));
    const elsewhere = await mkdtemp(join(tmpdir(), "pw-elsewhere-"));
    await symlink(elsewhere, join(dir, ".dev"));
    assert.equal(await writePortsFile(dir, { api: { role: "backend", port: 1 } }, 0), false);
    await assert.rejects(readFile(join(elsewhere, "ports.json"), "utf8"));
  });
});

describe("readPortsFile", () => {
  it("reads back what writePortsFile wrote", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pw-ports-"));
    await writePortsFile(dir, { api: { role: "backend", port: 4001 }, web: { role: "frontend", port: 4002 } }, 0);
    assert.deepEqual(await readPortsFile(dir), { api: 4001, web: 4002 });
  });

  it("returns null when there is no ports.json yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pw-ports-"));
    assert.equal(await readPortsFile(dir), null);
  });

  it("ignores malformed or tampered content instead of throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pw-ports-"));
    await writePortsFile(dir, { api: { role: "backend", port: 1 } }, 0);
    await writeFile(join(dir, ".dev", "ports.json"), "not json");
    assert.equal(await readPortsFile(dir), null);

    await writeFile(join(dir, ".dev", "ports.json"), JSON.stringify({ services: { api: { port: "not-a-number" }, web: { port: 99999 }, panel: { port: 4003 } } }));
    assert.deepEqual(await readPortsFile(dir), { panel: 4003 });
  });

  it("refuses to read through a .dev symlink", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pw-ports-"));
    const elsewhere = await mkdtemp(join(tmpdir(), "pw-elsewhere-"));
    await writeFile(join(elsewhere, "ports.json"), JSON.stringify({ services: { api: { port: 4001 } } }));
    await symlink(elsewhere, join(dir, ".dev"));
    assert.equal(await readPortsFile(dir), null);
  });
});
