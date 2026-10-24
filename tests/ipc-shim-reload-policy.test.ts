import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MIN_RELOAD_INTERVAL_MS, createReloadPolicy, isUnavailableError } from "../src/renderer/ipc/reload-policy";

describe("reload policy", () => {
  it("does not reload a page that never saw the core fail or go away", () => {
    const policy = createReloadPolicy();
    assert.equal(policy.onSidecarEvent(true, 1000), false);
    assert.equal(policy.onSidecarEvent(true, 2000), false);
  });

  it("reloads once when the core comes online after a call failed because it was not ready", () => {
    const policy = createReloadPolicy();
    policy.markUnavailable();
    assert.equal(policy.onSidecarEvent(true, 10_000), true);
    assert.equal(policy.onSidecarEvent(true, 20_000), false, "the stale flag is cleared by the reload");
  });

  it("reloads after an offline → online cycle (the core restarted)", () => {
    const policy = createReloadPolicy();
    assert.equal(policy.onSidecarEvent(false, 1000), false);
    assert.equal(policy.onSidecarEvent(true, 9000), true);
  });

  it("holds off while the previous reload is recent, then allows it later", () => {
    const policy = createReloadPolicy(10_000);
    policy.markUnavailable();
    assert.equal(policy.onSidecarEvent(true, 10_000 + MIN_RELOAD_INTERVAL_MS - 1), false);
    // 還是過期的狀態：間隔過後下一次上線事件仍會重載。
    assert.equal(policy.onSidecarEvent(true, 10_000 + MIN_RELOAD_INTERVAL_MS), true);
  });

  it("recognises the unavailable error by name only", () => {
    assert.equal(isUnavailableError({ name: "SidecarUnavailable", message: "x" }), true);
    assert.equal(isUnavailableError({ name: "InvalidIpcInputError" }), false);
    assert.equal(isUnavailableError("SidecarUnavailable"), false);
    assert.equal(isUnavailableError(null), false);
  });
});
