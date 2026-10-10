import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAllowedNavigationTarget, originFromUrl, type NavigationContext } from "@main/navigation-policy";

const packaged: NavigationContext = {
  devOrigin: null,
  packagedPrefix: "file:///Applications/Push%20Watch.app/Contents/Resources/app.asar/dist/renderer/"
};

const dev: NavigationContext = { ...packaged, devOrigin: "http://localhost:5177" };

describe("isAllowedNavigationTarget", () => {
  it("allows the bundled renderer pages when packaged", () => {
    assert.equal(
      isAllowedNavigationTarget(`${packaged.packagedPrefix}index.html`, packaged),
      true
    );
  });

  it("blocks files outside dist/renderer, including ../ traversal", () => {
    assert.equal(
      isAllowedNavigationTarget(
        "file:///Applications/Push%20Watch.app/Contents/Resources/app.asar/dist/renderer/../main/index.js",
        packaged
      ),
      false
    );
    assert.equal(isAllowedNavigationTarget("file:///etc/passwd", packaged), false);
  });

  it("blocks external and malformed URLs", () => {
    assert.equal(isAllowedNavigationTarget("https://example.com/", packaged), false);
    assert.equal(isAllowedNavigationTarget("javascript:alert(1)", packaged), false);
    assert.equal(isAllowedNavigationTarget("not a url", packaged), false);
  });

  it("follows whatever port the dev server was given, and still blocks every other port", () => {
    for (const port of [5173, 5199, 49152, 61234]) {
      const context: NavigationContext = { ...packaged, devOrigin: originFromUrl(`http://localhost:${port}/`) };
      assert.equal(isAllowedNavigationTarget(`http://localhost:${port}/index.html`, context), true);
      assert.equal(isAllowedNavigationTarget(`http://localhost:${port + 1}/`, context), false);
    }
  });

  it("allows only the dev origin while developing", () => {
    assert.equal(isAllowedNavigationTarget("http://localhost:5177/index.html", dev), true);
    assert.equal(isAllowedNavigationTarget("http://localhost:9999/", dev), false);
    assert.equal(isAllowedNavigationTarget("http://localhost:5177/", packaged), false);
  });
});

describe("originFromUrl", () => {
  it("extracts an origin or returns null", () => {
    assert.equal(originFromUrl("http://localhost:5177/path"), "http://localhost:5177");
    assert.equal(originFromUrl(undefined), null);
    assert.equal(originFromUrl("garbage"), null);
  });
});
