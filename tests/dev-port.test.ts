import assert from "node:assert/strict";
import net from "node:net";
import { describe, it } from "node:test";
import { DEV_PORT_START, isPortBusy, resolveDevPort } from "../scripts/dev-port";
import { MANUAL_START_PORTS } from "../src/shared/reserved-ports";

const busyOf = (...ports: number[]) => async (port: number): Promise<boolean> => ports.includes(port);

const listenOnFreePort = (): Promise<{ server: net.Server; port: number }> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1", exclusive: true }, () => {
      const address = server.address();
      if (address !== null && typeof address === "object") resolve({ server, port: address.port });
      else reject(new Error("no address"));
    });
  });

const close = (server: net.Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

describe("resolveDevPort", () => {
  it("保留清單包含 5173 與 5174，起點是 Vite 預設的 5173", () => {
    assert.deepEqual([...MANUAL_START_PORTS], [5173, 5174]);
    assert.equal(DEV_PORT_START, 5173);
  });

  it("PORT 合法就原樣使用，不再探測", async () => {
    let probed = 0;
    const port = await resolveDevPort({ env: { PORT: "41001" }, isBusy: async () => { probed += 1; return true; } });
    assert.equal(port, 41001);
    assert.equal(probed, 0);
  });

  it("PORT 落在保留號碼時報錯，不默默改號", async () => {
    for (const reserved of ["5173", "5174"]) {
      await assert.rejects(resolveDevPort({ env: { PORT: reserved }, isBusy: busyOf() }), /留給手動啟動/);
    }
  });

  it("PORT 不合法或沒給時當作沒指定，從 5175 開始（撇除 5173、5174）", async () => {
    for (const env of [{}, { PORT: undefined }, { PORT: "" }, { PORT: "abc" }, { PORT: "0" }, { PORT: "-1" }, { PORT: "70000" }, { PORT: "5175.5" }]) {
      assert.equal(await resolveDevPort({ env, isBusy: busyOf() }), 5175, JSON.stringify(env));
    }
  });

  it("5173、5174 就算沒人監聽也不會被選到", async () => {
    assert.equal(await resolveDevPort({ env: {}, isBusy: async () => false }), 5175);
  });

  it("往後跳過已有人監聽的 port", async () => {
    assert.equal(await resolveDevPort({ env: {}, isBusy: busyOf(5173, 5174, 5175, 5176) }), 5177);
  });

  it("保留清單不連續時也會跳過", async () => {
    assert.equal(await resolveDevPort({ env: {}, reserved: [5173, 5175], isBusy: busyOf(5174) }), 5176);
  });

  it("找到上限仍沒有空位就報錯", async () => {
    await assert.rejects(resolveDevPort({ env: {}, start: 65534, isBusy: async () => true }), /找不到可用/);
  });
});

describe("isPortBusy", () => {
  it("有人監聽時回傳 true，放掉後回傳 false", async () => {
    const { server, port } = await listenOnFreePort();
    try {
      assert.equal(await isPortBusy(port), true);
    } finally {
      await close(server);
    }
    assert.equal(await isPortBusy(port), false);
  });
});
