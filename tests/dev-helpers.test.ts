import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSupportedNode, parseNodeVersion, pickRendererUrl, sidecarSocketPath, tauriDevConfig } from "../scripts/dev-helpers";

describe("dev script helpers", () => {
  it("accepts Node 22.5 and newer only", () => {
    for (const version of ["22.5.0", "22.20.1", "v24.17.0", "23.0.0"]) assert.equal(isSupportedNode(version), true, version);
    for (const version of ["22.4.9", "20.19.0", "18.0.0", "", "latest"]) assert.equal(isSupportedNode(version), false, version);
    assert.deepEqual(parseNodeVersion("v24.17.0"), [24, 17, 0]);
    assert.equal(parseNodeVersion("nope"), null);
  });

  it("puts the sidecar socket in a per-user folder under the temp dir", () => {
    assert.equal(sidecarSocketPath("/var/folders/ab/T", 501), "/var/folders/ab/T/gitnrun-501/core.sock");
  });

  it("points tauri dev at the real renderer url and disables its own frontend command", () => {
    const config = JSON.parse(tauriDevConfig("http://localhost:5175/"));
    assert.deepEqual(config, { build: { devUrl: "http://localhost:5175/", beforeDevCommand: null } });
  });

  it("uses the url Vite reports and refuses to guess a port", () => {
    assert.equal(pickRendererUrl({ local: ["http://localhost:5176/"] }), "http://localhost:5176/");
    assert.throws(() => pickRendererUrl({ local: [] }));
    assert.throws(() => pickRendererUrl(null));
  });
});
