import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { allocatePorts, probePort, writePortsFile } from "@main/run/ports";

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
