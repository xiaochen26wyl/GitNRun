import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";
import { IPC } from "@shared/ipc";
import { handleIpc, invokeChannel, registeredChannels, resetIpcRegistry } from "@main/ipc";
import { asIdArgs, asNoArgs, InvalidIpcInputError } from "@main/ipc-validation";

describe("ipc channel registry", () => {
  beforeEach(() => {
    resetIpcRegistry();
    // 失敗的呼叫會記到 console.error，測試輸出不需要那些雜訊。
    mock.method(console, "error", () => undefined);
  });

  it("validates the raw arguments, then calls the handler with the parsed ones", async () => {
    const seen: number[] = [];
    handleIpc(IPC.projectsRemove, asIdArgs, (id) => {
      seen.push(id);
      return `removed ${id}`;
    });

    assert.equal(await invokeChannel(IPC.projectsRemove, [7]), "removed 7");
    assert.deepEqual(seen, [7]);
  });

  it("rejects invalid input without ever calling the handler", async () => {
    let called = false;
    handleIpc(IPC.projectsRemove, asIdArgs, (_id) => {
      called = true;
    });

    for (const bad of [[], ["7"], [-1], [1, 2], [{}], [null]]) {
      await assert.rejects(invokeChannel(IPC.projectsRemove, bad), InvalidIpcInputError, JSON.stringify(bad));
    }
    assert.equal(called, false);
  });

  it("refuses channels nobody registered (fail closed)", async () => {
    handleIpc(IPC.projectsList, asNoArgs, () => []);
    await assert.rejects(invokeChannel("projects:drop-everything", []), /unknown channel/);
    await assert.rejects(invokeChannel("", []), /unknown channel/);
    await assert.rejects(invokeChannel("constructor", []), /unknown channel/);
    await assert.rejects(invokeChannel("__proto__", []), /unknown channel/);
  });

  it("passes a handler's own error through unchanged, sync or async", async () => {
    const boom = new Error("handler failed");
    handleIpc(IPC.projectsList, asNoArgs, () => {
      throw boom;
    });
    handleIpc(IPC.eventsGet, asIdArgs, async (_id) => {
      throw boom;
    });

    await assert.rejects(invokeChannel(IPC.projectsList, []), (error) => error === boom);
    await assert.rejects(invokeChannel(IPC.eventsGet, [1]), (error) => error === boom);
  });

  it("returns whatever a handler resolves with, including undefined", async () => {
    handleIpc(IPC.projectsList, asNoArgs, () => undefined);
    handleIpc(IPC.eventsGet, asIdArgs, async (_id) => null);
    assert.equal(await invokeChannel(IPC.projectsList, []), undefined);
    assert.equal(await invokeChannel(IPC.eventsGet, [1]), null);
  });

  it("refuses to register one channel twice, and lists what is registered", () => {
    handleIpc(IPC.projectsList, asNoArgs, () => []);
    assert.throws(() => handleIpc(IPC.projectsList, asNoArgs, () => []), /registered twice/);
    handleIpc(IPC.eventsGet, asIdArgs, (_id) => null);
    assert.deepEqual(registeredChannels().sort(), [IPC.eventsGet, IPC.projectsList].sort());
  });
});
