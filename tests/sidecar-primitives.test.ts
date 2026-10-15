import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isForbiddenEnvName } from "@shared/run";
import { CIPHER_PREFIX, createAesGcmCipher, decodeMasterKey } from "@main/vault/aes-gcm-cipher";
import { FrameTooLargeError, createLineDecoder } from "@main/sidecar/framing";
import { LockHeldError, acquireLock } from "@main/sidecar/lock";
import { encodeFrame, parseFrame } from "@main/sidecar/protocol";

describe("AES-GCM vault cipher", () => {
  const key = randomBytes(32);

  it("round-trips, with a fresh iv each time", () => {
    const cipher = createAesGcmCipher(key);
    const a = cipher.encrypt("ghp_secret-value");
    const b = cipher.encrypt("ghp_secret-value");
    assert.ok(a.startsWith(CIPHER_PREFIX));
    assert.notEqual(a, b);
    assert.equal(cipher.decrypt(a), "ghp_secret-value");
    assert.equal(cipher.decrypt(cipher.encrypt("密碼 🔑")), "密碼 🔑");
  });

  it("detects tampering and a wrong key", () => {
    const cipher = createAesGcmCipher(key);
    const stored = cipher.encrypt("value");
    const bytes = Buffer.from(stored.slice(CIPHER_PREFIX.length), "base64");
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    assert.throws(() => cipher.decrypt(CIPHER_PREFIX + bytes.toString("base64")));
    assert.throws(() => createAesGcmCipher(randomBytes(32)).decrypt(stored));
  });

  it("refuses legacy safeStorage ciphertext and truncated input", () => {
    const cipher = createAesGcmCipher(key);
    assert.throws(() => cipher.decrypt(Buffer.from("v10legacy-electron-bytes").toString("base64")), /unsupported/);
    assert.throws(() => cipher.decrypt(`${CIPHER_PREFIX}AAAA`), /truncated/);
  });

  it("is unavailable, and never falls back to plaintext, without a valid key", () => {
    for (const bad of [null, Buffer.alloc(16), Buffer.alloc(33)]) {
      const cipher = createAesGcmCipher(bad);
      assert.equal(cipher.isAvailable(), false);
      assert.throws(() => cipher.encrypt("x"));
    }
    assert.equal(decodeMasterKey(key.toString("base64"))?.equals(key), true);
    for (const bad of [undefined, "", "not base64!!", Buffer.alloc(8).toString("base64"), 42]) {
      assert.equal(decodeMasterKey(bad), null);
    }
  });
});

describe("sidecar line framing", () => {
  it("splits merged chunks and joins split ones, including across a multibyte character", () => {
    const decoder = createLineDecoder();
    assert.deepEqual(decoder.push(Buffer.from('{"a":1}\n{"b":2}\n')), ['{"a":1}', '{"b":2}']);

    const full = Buffer.from('{"t":"中文"}\n');
    const cut = full.indexOf(0xe4) + 1; // 在「中」的 3 個位元組中間切開
    assert.deepEqual(decoder.push(full.subarray(0, cut)), []);
    assert.deepEqual(decoder.push(full.subarray(cut)), ['{"t":"中文"}']);
  });

  it("skips blank lines and rejects frames over the limit, whether or not the newline arrived", () => {
    assert.deepEqual(createLineDecoder().push(Buffer.from("\n\n{}\n")), ["{}"]);
    assert.throws(() => createLineDecoder(8).push(Buffer.from("123456789\n")), FrameTooLargeError);
    const slow = createLineDecoder(8);
    slow.push(Buffer.from("12345"));
    assert.throws(() => slow.push(Buffer.from("6789")), FrameTooLargeError);
  });
});

describe("sidecar protocol frames", () => {
  it("round-trips the three frame kinds and distinguishes undefined from null", () => {
    for (const frame of [
      { k: "req", id: 1, m: "ipc.invoke", p: { channel: "app:info", args: [] } },
      { k: "res", id: 1, ok: true },
      { k: "res", id: 2, ok: true, v: null },
      { k: "res", id: 3, ok: false, e: { name: "UserFacingError", message: "nope" } },
      { k: "evt", m: "push", p: { channel: "monitor:changed" } }
    ] as const) {
      assert.deepEqual(parseFrame(encodeFrame(frame).trim()), frame);
    }
    assert.equal("v" in (parseFrame('{"k":"res","id":1,"ok":true}') as object), false);
    assert.equal((parseFrame('{"k":"res","id":1,"ok":true,"v":null}') as { v: unknown }).v, null);
  });

  it("rejects anything malformed", () => {
    for (const bad of ["", "not json", "[]", "null", '{"k":"req"}', '{"k":"req","id":-1,"m":"x"}', '{"k":"req","id":1.5,"m":"x"}',
      '{"k":"req","id":1,"m":"has space"}', '{"k":"res","id":1}', '{"k":"res","id":1,"ok":false}', '{"k":"other","m":"x"}']) {
      assert.equal(parseFrame(bad), null, bad);
    }
  });
});

describe("sidecar data-directory lock", () => {
  const withDir = (fn: (dir: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), "gnr-lock-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("refuses a second live holder, takes over a stale one, and only releases its own", () => {
    withDir((dir) => {
      const path = join(dir, "sidecar.pid");
      const first = acquireLock(path, { pid: 111, isAlive: () => true });
      assert.throws(() => acquireLock(path, { pid: 222, isAlive: () => true }), LockHeldError);

      const second = acquireLock(path, { pid: 222, isAlive: () => false });
      first.release(); // 已被接手，不能刪掉別人的鎖
      assert.equal(readFileSync(path, "utf8"), "222");
      second.release();
      assert.throws(() => readFileSync(path, "utf8"));
    });
  });

  it("treats a garbage lock file as stale", () => {
    withDir((dir) => {
      const path = join(dir, "sidecar.pid");
      writeFileSync(path, "not a pid");
      acquireLock(path, { pid: 333, isAlive: () => true }).release();
    });
  });
});

describe("environment names reserved for the sidecar", () => {
  it("cannot be set from a rule or manifest", () => {
    assert.equal(isForbiddenEnvName("GITNRUN_SIDECAR_TOKEN"), true);
    assert.equal(isForbiddenEnvName("GITNRUN_SIDECAR_SOCKET"), true);
    assert.equal(isForbiddenEnvName("GITNRUN_OTHER"), false);
  });
});
