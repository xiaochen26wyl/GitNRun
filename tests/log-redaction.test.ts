import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createValueRedactor, redact, redactDeep, redactSecrets } from "@main/log-redaction";

const GITHUB_CLASSIC = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const GITHUB_FINE = "github_pat_" + "11ABCDEFG0abcdefghij_klmnopqrstuvwxyz0123456789ABCDEFGHIJ";
const ANTHROPIC = "sk-ant-api03-" + "abcDEF123_456-ghiJKL";
const OPENAI = "sk-proj-" + "abcdefghijklmnopqrstuvwxyz0123456789";
const SLACK_TOKEN = "xoxb-" + "123456789012-abcdefghijkl";
const SLACK_HOOK = "https://hooks.slack.com/services/T0000/B0000/abcdefghijklmnop";

describe("redactSecrets", () => {
  it("masks well-known token formats", () => {
    for (const secret of [GITHUB_CLASSIC, GITHUB_FINE, ANTHROPIC, OPENAI, SLACK_TOKEN]) {
      const out = redactSecrets(`failed with ${secret} while calling`);
      assert.ok(!out.includes(secret), `leaked: ${secret}`);
      assert.ok(out.includes("failed with"), "surrounding text is preserved");
    }
    assert.ok(!redactSecrets(`url ${SLACK_HOOK}`).includes("abcdefghijklmnop"));
    assert.ok(redactSecrets(`url ${SLACK_HOOK}`).includes("hooks.slack.com/services/[redacted]"));
  });

  it("masks Authorization headers including the scheme's token", () => {
    const out = redactSecrets("Authorization: Bearer abc.def-123_xyz");
    assert.ok(!out.includes("abc.def-123_xyz"));
    assert.ok(!redactSecrets("authorization=Basic dXNlcjpwYXNzd29yZA==").includes("dXNlcjpwYXNzd29yZA"));
    assert.ok(!redactSecrets("x-api-key: supersecretvalue123").includes("supersecretvalue123"));
  });

  it("masks JSON credential fields and env-style assignments", () => {
    const json = redactSecrets('{"access_token":"tok-value-1","apiKey":"key-value-2","user":"alice"}');
    assert.ok(!json.includes("tok-value-1"));
    assert.ok(!json.includes("key-value-2"));
    assert.ok(json.includes("alice"));

    const env = redactSecrets("GITHUB_TOKEN=abc123xyz ANTHROPIC_API_KEY=zzz999 PATH=/usr/bin");
    assert.ok(!env.includes("abc123xyz"));
    assert.ok(!env.includes("zzz999"));
    assert.ok(env.includes("PATH=/usr/bin"));
  });

  it("masks credentials embedded in URLs", () => {
    const out = redactSecrets("remote https://x-access-token:secretpass@github.com/acme/widgets.git");
    assert.ok(!out.includes("secretpass"));
    assert.ok(out.includes("github.com/acme/widgets.git"));
  });

  it("leaves ordinary text alone", () => {
    const text = "feat: add login (sk-learn is a library) on branch v010_2026_1009";
    assert.equal(redactSecrets(text), text);
  });
});

describe("redact", () => {
  it("collapses an Error to name and message only", () => {
    const error = Object.assign(new Error(`spawn failed for ${GITHUB_CLASSIC}`), {
      cmd: `git push https://x:${GITHUB_CLASSIC}@github.com/a/b`,
      config: { headers: { Authorization: `Bearer ${GITHUB_CLASSIC}` } }
    });
    const out = redact(error);
    assert.ok(!out.includes(GITHUB_CLASSIC));
    assert.ok(!out.includes("config"));
    assert.ok(!out.includes("cmd"));
    assert.ok(out.startsWith("Error: "));
  });

  it("handles non-string values", () => {
    assert.equal(redact(42), "42");
    assert.equal(redact(null), "null");
    assert.equal(redact({ toString: () => { throw new Error("x"); } }), "[unprintable]");
  });
});

describe("redactDeep", () => {
  it("masks secret-named keys and scans nested strings", () => {
    const out = redactDeep({
      user: "alice",
      token: "plain-token-value",
      nested: { password: "hunter2", note: `uses ${GITHUB_CLASSIC} today` },
      list: [`Bearer abc.def`, { apiKey: "k" }],
      error: new Error(`boom ${ANTHROPIC}`)
    });
    const json = JSON.stringify(out);
    for (const leaked of ["plain-token-value", "hunter2", GITHUB_CLASSIC, "abc.def", ANTHROPIC]) {
      assert.ok(!json.includes(leaked), `leaked ${leaked}`);
    }
    assert.ok(json.includes("alice"));
  });

  it("stops at a depth limit instead of recursing forever", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.doesNotThrow(() => redactDeep(cyclic));
  });
});

describe("createValueRedactor", () => {
  it("replaces known secret values exactly, longest first", () => {
    const redactor = createValueRedactor(["abcdef123456", "abcdef"]);
    assert.equal(redactor("value=abcdef123456 and abcdef"), "value=[redacted] and [redacted]");
  });

  it("escapes regex metacharacters in secret values", () => {
    const redactor = createValueRedactor(["a.b*c+d(e)[f]"]);
    assert.equal(redactor("x a.b*c+d(e)[f] y aXb"), "x [redacted] y aXb");
  });

  it("ignores values too short to be safely matched", () => {
    const redactor = createValueRedactor(["abc", ""]);
    assert.equal(redactor("abc abc"), "abc abc");
  });
});
