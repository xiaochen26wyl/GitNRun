import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_EXCLUDE_GLOBS } from "@shared/ai";
import { maskSecrets, prepareDiff, splitDiff } from "@main/ai/diff-prep";

const section = (path: string, body: string): string => `diff --git a/${path} b/${path}\nindex 111..222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${body}`;
const options = { excludeGlobs: DEFAULT_EXCLUDE_GLOBS, maxBytes: 60_000 };

const TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxxxxxxxxxxxx\n-----END RSA PRIVATE KEY-----";

describe("splitDiff", () => {
  it("splits at each file header and reads plain and quoted paths", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "+a",
      'diff --git "a/my file.ts" "b/my file.ts"',
      "+b"
    ].join("\n");
    const sections = splitDiff(diff);

    assert.deepEqual(sections.map((entry) => entry.path), ["src/a.ts", "my file.ts"]);
    assert.ok(sections[0]?.text.includes("+a") && !sections[0].text.includes("+b"));
  });

  it("copes with an empty diff", () => {
    assert.deepEqual(splitDiff(""), [{ path: null, text: "" }]);
  });
});

describe("maskSecrets", () => {
  it("masks tokens, private keys, cloud keys, JWTs and quoted credentials, and counts them", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop";
    const input = `a ${TOKEN}\n${PEM}\nkey AKIAABCDEFGHIJKLMNOP\njwt ${jwt}\npassword = "hunter2hunter2"`;
    const { text, count } = maskSecrets(input);

    for (const leaked of [TOKEN, "MIIEowIBAAKCAQEA", "AKIAABCDEFGHIJKLMNOP", jwt, "hunter2hunter2"]) {
      assert.ok(!text.includes(leaked), `leaked: ${leaked}`);
    }
    assert.equal(count, 5);
  });

  it("leaves ordinary code alone", () => {
    const code = 'const password = getPassword();\nconst name = "alice";\n// token count: 3';
    assert.deepEqual(maskSecrets(code), { text: code, count: 0 });
  });
});

describe("prepareDiff", () => {
  it("keeps ordinary files and reports which were included", () => {
    const prepared = prepareDiff([section("src/a.ts", "+one"), section("src/b.ts", "+two")].join("\n"), options);
    assert.deepEqual(prepared.includedFiles, ["src/a.ts", "src/b.ts"]);
    assert.deepEqual(prepared.excludedFiles, []);
    assert.ok(prepared.text.includes("+one") && prepared.text.includes("+two"));
    assert.equal(prepared.truncated, false);
    assert.equal(prepared.bytes, Buffer.byteLength(prepared.text));
  });

  it("never sends the content of excluded files — only their names", () => {
    const diff = [
      section("src/a.ts", "+ok"),
      section(".env", "+API_KEY=super-secret-value-12345"),
      section("config/server.pem", "+-----BEGIN CERTIFICATE-----"),
      section("pnpm-lock.yaml", "+resolution: huge"),
      section("deploy/my-secret.json", "+hidden"),
      section("src/deep/.env.production", "+DB_PASSWORD=also-secret-1234")
    ].join("\n");

    const prepared = prepareDiff(diff, options);

    assert.deepEqual(prepared.includedFiles, ["src/a.ts"]);
    assert.deepEqual(prepared.excludedFiles, [".env", "config/server.pem", "pnpm-lock.yaml", "deploy/my-secret.json", "src/deep/.env.production"]);
    for (const leaked of ["super-secret-value-12345", "BEGIN CERTIFICATE", "resolution: huge", "hidden", "also-secret-1234"]) {
      assert.ok(!prepared.text.includes(leaked), leaked);
    }
    assert.ok(prepared.text.includes("[內容已排除，不會送出]"));
  });

  it("masks secrets inside files that are sent, and says how many", () => {
    const prepared = prepareDiff(section("src/client.ts", `+const t = "${TOKEN}";`), options);
    assert.ok(!prepared.text.includes(TOKEN));
    assert.equal(prepared.maskedCount, 1);
  });

  it("truncates at the byte limit on file boundaries and never exceeds it by more than the note", () => {
    const big = (name: string) => section(name, `+${"x".repeat(2_000)}`);
    const prepared = prepareDiff([big("a.ts"), big("b.ts"), big("c.ts"), big("d.ts")].join("\n"), { excludeGlobs: [], maxBytes: 5_000 });

    assert.equal(prepared.truncated, true);
    assert.ok(prepared.bytes < 5_000 + 600, `bytes ${prepared.bytes}`);
    assert.ok(prepared.includedFiles.length >= 2 && prepared.includedFiles.length <= 3);
    assert.ok(prepared.text.includes("已截斷") || prepared.text.includes("超過大小上限"));
  });

  it("an honestly small diff is never marked truncated", () => {
    assert.equal(prepareDiff(section("a.ts", "+x"), { excludeGlobs: [], maxBytes: 1_000 }).truncated, false);
  });

  it("an empty diff produces an empty result", () => {
    const prepared = prepareDiff("", options);
    assert.deepEqual([prepared.includedFiles, prepared.excludedFiles, prepared.bytes], [[], [], 0]);
  });
});
