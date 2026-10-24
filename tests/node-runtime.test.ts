import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  IntegrityError,
  archiveUrl,
  binaryFileName,
  isAcceptableLocalNode,
  nodePathInArchive,
  sha256Of,
  targetFor,
  tripleFor,
  verifyArchive,
  type RuntimeManifest
} from "../scripts/node-runtime";

const manifest = JSON.parse(readFileSync("scripts/node-runtime.json", "utf8")) as RuntimeManifest;

describe("bundled node runtime", () => {
  it("only trusts downloads whose size and SHA-256 both match the pinned values", () => {
    const data = new TextEncoder().encode("pretend this is node");
    const target = { archive: "x.tar.gz", sha256: sha256Of(data), bytes: data.byteLength };
    assert.doesNotThrow(() => verifyArchive(data, target));

    const tampered = new TextEncoder().encode("pretend this is nodE");
    assert.throws(() => verifyArchive(tampered, target), IntegrityError);
    assert.throws(() => verifyArchive(data, { ...target, sha256: "0".repeat(64) }), IntegrityError);
    assert.throws(() => verifyArchive(data, { ...target, bytes: data.byteLength + 1 }), IntegrityError);
    // 大小對、內容被換掉也要擋住（只看大小不夠）。
    assert.throws(() => verifyArchive(tampered, { ...target, bytes: tampered.byteLength }), IntegrityError);
  });

  it("maps node architectures to Tauri target triples and externalBin file names", () => {
    assert.equal(tripleFor("arm64"), "aarch64-apple-darwin");
    assert.equal(tripleFor("x64"), "x86_64-apple-darwin");
    assert.equal(tripleFor("ia32"), null);
    assert.equal(binaryFileName("aarch64-apple-darwin"), "gitnrun-node-aarch64-apple-darwin");
  });

  it("pins an official https download and a hash for every supported triple", () => {
    for (const triple of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
      const target = targetFor(manifest, triple);
      assert.match(target.sha256, /^[0-9a-f]{64}$/);
      assert.ok(target.bytes > 10_000_000);
      const url = new URL(archiveUrl(manifest, target));
      assert.equal(url.protocol, "https:");
      assert.equal(url.hostname, "nodejs.org");
      assert.ok(url.pathname.includes(`v${manifest.version}`));
      assert.ok(target.archive.includes(manifest.version));
    }
    assert.throws(() => targetFor(manifest, "x86_64-pc-windows-msvc"));
  });

  it("extracts only bin/node from the archive and accepts only the pinned major locally", () => {
    assert.equal(nodePathInArchive("node-v24.17.0-darwin-x64.tar.gz"), "node-v24.17.0-darwin-x64/bin/node");
    assert.equal(isAcceptableLocalNode("24.17.0"), true);
    assert.equal(isAcceptableLocalNode("22.20.1"), false);
    assert.equal(isAcceptableLocalNode("240.0.0"), false);
  });
});
