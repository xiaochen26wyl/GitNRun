import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IPC } from "@shared/ipc";
import { MASK_PREFIX } from "@shared/secrets";
import { asSecretNameArgs, asSecretSetArgs, asSecretValue, isKnownChannel } from "@main/ipc-validation";
import { testSecret } from "@main/secret-test";
import { assessGithubToken, testGithubToken, type FetchFn } from "@main/github-token-check";
import { createVault } from "@main/vault/vault";
import { createTestDb } from "./helpers/db";
import { createFakeCipher } from "./helpers/fake-cipher";

const FINE_GRAINED = "github_pat_" + "11ABCDEFG0abcdefghij_klmnopqrstuvwxyzWXYZ";
const CLASSIC = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

describe("secret IPC channels", () => {
  it("are declared and recognised", () => {
    for (const channel of [IPC.secretsOverview, IPC.secretsSet, IPC.secretsDelete, IPC.secretsTest]) {
      assert.equal(isKnownChannel(channel), true);
    }
  });
});

describe("asSecretValue", () => {
  it("trims pasted whitespace and newlines", () => {
    assert.deepEqual(asSecretValue("  ghp_abc123  \n"), { kind: "value", value: "ghp_abc123" });
  });

  it("treats an echoed mask as 'unchanged' so it can never overwrite a stored key", () => {
    assert.deepEqual(asSecretValue(`${MASK_PREFIX}WXYZ`), { kind: "unchanged" });
    assert.deepEqual(asSecretValue(MASK_PREFIX), { kind: "unchanged" });
  });

  it("rejects empty, oversized, control-character and non-string values", () => {
    assert.equal(asSecretValue(""), null);
    assert.equal(asSecretValue("   "), null);
    assert.equal(asSecretValue("x".repeat(4097)), null);
    assert.equal(asSecretValue("a\nb"), null);
    assert.equal(asSecretValue("a\u0000b"), null);
    assert.equal(asSecretValue(123), null);
    assert.equal(asSecretValue(null), null);
  });
});

describe("secret IPC argument validators", () => {
  it("only accept known secret names", () => {
    assert.deepEqual(asSecretNameArgs(["github.pat"]), ["github.pat"]);
    assert.deepEqual(asSecretNameArgs(["webhook.secret.4"]), ["webhook.secret.4"]);
    assert.equal(asSecretNameArgs(["../x"]), null);
    assert.equal(asSecretNameArgs([]), null);
    assert.equal(asSecretNameArgs(["github.pat", "extra"]), null);
    assert.equal(asSecretNameArgs([{ toString: () => "github.pat" }]), null);
  });

  it("require exactly a name and a value", () => {
    assert.deepEqual(asSecretSetArgs(["github.pat", "tok"]), ["github.pat", { kind: "value", value: "tok" }]);
    assert.equal(asSecretSetArgs(["github.pat"]), null);
    assert.equal(asSecretSetArgs(["nope", "tok"]), null);
    assert.equal(asSecretSetArgs(["github.pat", ""]), null);
    assert.equal(asSecretSetArgs(["github.pat", "tok", "extra"]), null);
  });
});

describe("assessGithubToken", () => {
  it("flags a classic token with write scopes", () => {
    const result = assessGithubToken(CLASSIC, "repo, read:user");
    assert.equal(result.kind, "classic");
    assert.deepEqual(result.scopes, ["repo", "read:user"]);
    assert.ok(result.warnings[0]?.includes("repo"));
  });

  it("still recommends fine-grained for a read-only classic token", () => {
    const result = assessGithubToken(CLASSIC, "read:user");
    assert.equal(result.kind, "classic");
    assert.ok(result.warnings.some((warning) => warning.includes("fine-grained")));
  });

  it("treats github_pat_ tokens as fine-grained and asks for manual confirmation", () => {
    const result = assessGithubToken(FINE_GRAINED, null);
    assert.equal(result.kind, "fine-grained");
    assert.ok(result.warnings[0]?.includes("Contents: Read"));
    assert.ok(result.warnings[0]?.includes("Issues: Read"));
  });
});

const respond = (status: number, scopes: string | null, body: unknown = { login: "octocat" }): FetchFn =>
  async () => ({
    status,
    headers: { get: (name) => (name.toLowerCase() === "x-oauth-scopes" ? scopes : null) },
    json: async () => body
  });

describe("testGithubToken", () => {
  it("reports success with the account name and permission warnings", async () => {
    const result = await testGithubToken(CLASSIC, respond(200, "repo"));
    assert.equal(result.ok, true);
    assert.ok(result.message.includes("octocat"));
    assert.ok(result.warnings.length > 0);
  });

  it("maps 401 and 403 to clear messages without echoing anything sensitive", async () => {
    const unauthorized = await testGithubToken(CLASSIC, respond(401, null));
    assert.equal(unauthorized.ok, false);
    assert.ok(unauthorized.message.includes("401"));
    const forbidden = await testGithubToken(CLASSIC, respond(403, null));
    assert.equal(forbidden.ok, false);
    assert.ok(!JSON.stringify([unauthorized, forbidden]).includes(CLASSIC));
  });

  it("handles network failure", async () => {
    const result = await testGithubToken(CLASSIC, async () => {
      throw new Error(`connect failed with ${CLASSIC}`);
    });
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes(CLASSIC));
  });

  it("sends the token only in the Authorization header", async () => {
    let captured: Record<string, string> = {};
    let url = "";
    await testGithubToken(CLASSIC, async (requestUrl, init) => {
      url = requestUrl;
      captured = init.headers;
      return { status: 200, headers: { get: () => null }, json: async () => ({}) };
    });
    assert.ok(!url.includes(CLASSIC));
    assert.equal(captured.Authorization, `Bearer ${CLASSIC}`);
  });
});

describe("testSecret", () => {
  it("tests the stored GitHub token without exposing it", async () => {
    const db = createTestDb();
    const vault = createVault(db, createFakeCipher());
    vault.set("github.pat", FINE_GRAINED);

    const result = await testSecret(vault, "github.pat", respond(200, null));

    assert.equal(result.ok, true);
    assert.ok(!JSON.stringify(result).includes(FINE_GRAINED));
  });

  it("explains a missing or unreadable key and unsupported names", async () => {
    const db = createTestDb();
    const cipher = createFakeCipher();
    const vault = createVault(db, cipher);

    assert.equal((await testSecret(vault, "github.pat", respond(200, null))).message, "尚未設定。");
    assert.equal((await testSecret(vault, "ai.openai", respond(200, null))).ok, false);

    vault.set("github.pat", FINE_GRAINED);
    cipher.brokenCiphertexts.add(String(db.prepare("SELECT ciphertext FROM api_keys").get()?.ciphertext));
    assert.ok((await testSecret(vault, "github.pat", respond(200, null))).message.includes("重新輸入"));
  });
});
