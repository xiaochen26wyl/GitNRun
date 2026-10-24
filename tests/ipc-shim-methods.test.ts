import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IPC } from "@shared/ipc";
import { INVOKE_METHODS } from "../src/renderer/ipc/methods";

describe("ipc shim method table", () => {
  it("maps every invoke channel to exactly one method", () => {
    const channels = Object.values(INVOKE_METHODS);
    assert.equal(new Set(channels).size, channels.length, "有兩個方法對到同一個通道");
    assert.deepEqual([...channels].sort(), Object.values(IPC).sort());
  });
});
