import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSecureWebPreferences } from "@main/web-preferences";

describe("buildSecureWebPreferences", () => {
  it("always isolates the renderer", () => {
    const prefs = buildSecureWebPreferences();
    assert.equal(prefs.contextIsolation, true);
    assert.equal(prefs.nodeIntegration, false);
    assert.equal(prefs.nodeIntegrationInWorker, false);
    assert.equal(prefs.nodeIntegrationInSubFrames, false);
    assert.equal(prefs.sandbox, true);
    assert.equal(prefs.webSecurity, true);
    assert.equal(prefs.allowRunningInsecureContent, false);
    assert.equal(prefs.webviewTag, false);
  });

  it("includes the preload only when given", () => {
    assert.equal(buildSecureWebPreferences().preload, undefined);
    assert.equal(buildSecureWebPreferences("/tmp/preload.js").preload, "/tmp/preload.js");
  });
});
