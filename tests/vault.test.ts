import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  InvalidSecretError,
  SecretMissingError,
  SecretUnreadableError,
  VaultUnavailableError,
  createVault,
  secretHint
} from "@main/vault/vault";
import { exportConfig } from "@main/db/backup";
import { createTestDb } from "./helpers/db";
import { createFakeCipher } from "./helpers/fake-cipher";

const GITHUB_TOKEN = "github_pat_" + "11ABCDEFG0abcdefghij_klmnopqrstuvwxyzWXYZ";

const setup = () => {
  const db = createTestDb();
  const cipher = createFakeCipher();
  let now = 1000;
  const vault = createVault(db, cipher, () => now);
  return { db, cipher, vault, tick: (to: number) => (now = to) };
};

describe("vault storage", () => {
  it("round-trips a secret through the cipher and stores only ciphertext", async () => {
    const { db, vault } = setup();
    const status = vault.set("github.pat", GITHUB_TOKEN);

    assert.equal(status.configured, true);
    assert.equal(status.state, "ok");
    assert.equal(await vault.useSecret("github.pat", (secret) => secret), GITHUB_TOKEN);

    const row = db.prepare("SELECT * FROM api_keys WHERE name = 'github.pat'").get();
    assert.ok(row);
    assert.ok(!JSON.stringify(row).includes(GITHUB_TOKEN), "plaintext must never be stored");
    assert.notEqual(row.ciphertext, GITHUB_TOKEN);
  });

  it("refuses to store anything when encryption is unavailable (no plaintext fallback)", () => {
    const { db, cipher, vault } = setup();
    cipher.available = false;

    assert.throws(() => vault.set("github.pat", GITHUB_TOKEN), VaultUnavailableError);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM api_keys").get()?.n), 0);
    assert.equal(vault.overview().available, false);
  });

  it("reports an unreadable secret instead of ever returning ciphertext", async () => {
    const { db, cipher, vault } = setup();
    vault.set("ai.anthropic", "sk-ant-api03-abcdefghijklmnop");
    const ciphertext = String(db.prepare("SELECT ciphertext FROM api_keys").get()?.ciphertext);
    cipher.brokenCiphertexts.add(ciphertext);

    assert.equal(vault.getStatus("ai.anthropic").state, "unreadable");
    await assert.rejects(vault.useSecret("ai.anthropic", (secret) => secret), SecretUnreadableError);
  });

  it("throws a typed error for a secret that was never set", async () => {
    const { vault } = setup();
    await assert.rejects(vault.useSecret("github.pat", (secret) => secret), SecretMissingError);
    assert.equal(vault.getStatus("github.pat").state, "missing");
  });

  it("replaces a value, keeps created_at and bumps updated_at", () => {
    const { db, vault, tick } = setup();
    vault.set("ai.openai", "sk-proj-first-first-first");
    tick(5000);
    vault.set("ai.openai", "sk-proj-second-second-second");

    const row = db.prepare("SELECT created_at, updated_at FROM api_keys").get();
    assert.equal(row?.created_at, 1000);
    assert.equal(row?.updated_at, 5000);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM api_keys").get()?.n), 1);
  });

  it("deletes and reports as missing afterwards", () => {
    const { vault } = setup();
    vault.set("smtp.password", "correct-horse-battery");
    vault.delete("smtp.password");
    assert.equal(vault.has("smtp.password"), false);
    assert.equal(vault.getStatus("smtp.password").configured, false);
  });
});

describe("vault input validation", () => {
  it("rejects unknown names, empty values, oversized values and control characters", () => {
    const { vault } = setup();
    assert.throws(() => vault.set("../../etc/passwd", "value-value-value"), InvalidSecretError);
    assert.throws(() => vault.set("github.pat; DROP TABLE api_keys", "value-value-value"), InvalidSecretError);
    assert.throws(() => vault.set("github.pat", ""), InvalidSecretError);
    assert.throws(() => vault.set("github.pat", "x".repeat(5000)), InvalidSecretError);
    assert.throws(() => vault.set("github.pat", "line1\nline2"), InvalidSecretError);
    assert.throws(() => vault.getStatus("nope"), InvalidSecretError);
  });

  it("accepts per-project webhook secrets and rule env secrets by pattern", () => {
    const { vault } = setup();
    assert.equal(vault.set("webhook.secret.12", "0123456789abcdef0123456789abcdef").configured, true);
    assert.equal(vault.set("env.3.DEPLOY_KEY", "deploy-key-value-1234").configured, true);
    assert.throws(() => vault.set("env.3.lowercase", "deploy-key-value-1234"), InvalidSecretError);
    assert.throws(() => vault.set("webhook.secret.abc", "x".repeat(20)), InvalidSecretError);
  });

  it("accepts dev passcodes for run-page targets only in the devpass.<p|f><id> shape", () => {
    const { vault } = setup();
    assert.equal(vault.set("devpass.p3", "dev-passcode-0042").configured, true);
    assert.equal(vault.set("devpass.f12", "dev-passcode-0042").configured, true);
    for (const name of ["devpass.p0", "devpass.x3", "devpass.p", "devpass.p3.extra", "devpass.p01", "devpass.p1234567890", "devpass.", "devpass.p3\n"]) {
      assert.throws(() => vault.set(name, "dev-passcode-0042"), InvalidSecretError, name);
    }
  });
});

describe("what the renderer can learn", () => {
  it("overview contains status only: no plaintext, no ciphertext", () => {
    const { db, vault } = setup();
    vault.set("github.pat", GITHUB_TOKEN);
    vault.set("ai.anthropic", "sk-ant-api03-abcdefghijklmnop");
    const ciphertexts = db
      .prepare("SELECT ciphertext FROM api_keys")
      .all()
      .map((row) => String(row.ciphertext));

    const payload = JSON.stringify(vault.overview());

    assert.ok(!payload.includes(GITHUB_TOKEN));
    assert.ok(!payload.includes("sk-ant-api03-abcdefghijklmnop"));
    for (const ciphertext of ciphertexts) {
      assert.ok(!payload.includes(ciphertext));
    }
    // 末四碼是刻意提供給 UI 辨識用的，應該在。
    assert.ok(payload.includes(GITHUB_TOKEN.slice(-4)));
  });

  it("lists every fixed secret even when unset, plus dynamic ones that exist", () => {
    const { vault } = setup();
    vault.set("webhook.secret.7", "0123456789abcdef0123456789abcdef");
    const names = vault.overview().secrets.map((status) => status.name);
    assert.deepEqual(names.slice(0, 5), ["github.pat", "ai.anthropic", "ai.openai", "notify.slack_webhook", "smtp.password"]);
    assert.ok(names.includes("webhook.secret.7"));
  });

  it("only shows a hint for secrets long enough that four characters are harmless", () => {
    assert.equal(secretHint("short-secret"), "cret");
    assert.equal(secretHint("tiny"), "");
    assert.equal(secretHint("12345678901"), "");
  });
});

describe("backups never contain secrets", () => {
  it("exports no key material even when keys are configured", () => {
    const { db, vault } = setup();
    vault.set("github.pat", GITHUB_TOKEN);
    const ciphertext = String(db.prepare("SELECT ciphertext FROM api_keys").get()?.ciphertext);

    const json = JSON.stringify(exportConfig(db));

    assert.ok(!json.includes(GITHUB_TOKEN));
    assert.ok(!json.includes(ciphertext));
    assert.ok(!json.includes(GITHUB_TOKEN.slice(-4)));
  });
});
