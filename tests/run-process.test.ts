import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { runProcess } from "@main/exec/run-process";

const root = realpathSync(mkdtempSync(join(tmpdir(), "gitnrun-proc-")));
after(() => rmSync(root, { recursive: true, force: true }));

const sh = (script: string, extra: { timeoutMs?: number; env?: Record<string, string>; cwd?: string; maxOutputBytes?: number; killGraceMs?: number; onOutput?: (chunk: { stream: string; text: string }) => void } = {}) =>
  runProcess({
    file: "/bin/sh",
    args: ["-c", script],
    cwd: extra.cwd ?? root,
    env: extra.env ?? { PATH: "/usr/bin:/bin" },
    timeoutMs: extra.timeoutMs ?? 5_000,
    killGraceMs: extra.killGraceMs ?? 200,
    maxOutputBytes: extra.maxOutputBytes,
    onOutput: extra.onOutput as never
  });

describe("runProcess", () => {
  it("captures stdout, stderr and the exit code", async () => {
    const result = await sh("echo out; echo err 1>&2; exit 3");
    assert.equal(result.code, 3);
    assert.equal(result.stdout, "out\n");
    assert.equal(result.stderr, "err\n");
    assert.equal(result.timedOut, false);
    assert.equal(result.spawnError, undefined);
    assert.ok(result.durationMs >= 0);
  });

  it("runs in the given directory", async () => {
    const result = await sh("pwd");
    assert.equal(result.stdout.trim(), root);
  });

  it("gives the child only the environment it is handed, not this process's", async () => {
    process.env.PW_TEST_LEAK = "leaked";
    try {
      const result = await sh('printf "[%s][%s]" "$PW_TEST_LEAK" "$ONLY_HERE"', { env: { PATH: "/usr/bin:/bin", ONLY_HERE: "yes" } });
      assert.equal(result.stdout, "[][yes]");
    } finally {
      delete process.env.PW_TEST_LEAK;
    }
  });

  it("streams output as it arrives", async () => {
    const chunks: Array<{ stream: string; text: string }> = [];
    await sh("echo one; sleep 0.1; echo two 1>&2", { onOutput: (chunk) => chunks.push(chunk) });
    assert.deepEqual(chunks.map((chunk) => `${chunk.stream}:${chunk.text.trim()}`), ["stdout:one", "stderr:two"]);
  });

  it("stops a command that runs too long and says so", async () => {
    const start = Date.now();
    const result = await sh("sleep 30", { timeoutMs: 150 });
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - start < 3_000, "returned promptly after the timeout");
    assert.ok(result.signal === "SIGTERM" || result.code !== 0);
  });

  it("escalates to SIGKILL when the command ignores SIGTERM", async () => {
    const start = Date.now();
    const result = await sh("trap '' TERM; sleep 30", { timeoutMs: 100, killGraceMs: 150 });
    assert.equal(result.timedOut, true);
    assert.equal(result.signal, "SIGKILL");
    assert.ok(Date.now() - start < 3_000);
  });

  it("takes the whole process group down, including background children", async () => {
    const marker = join(root, "survivor");
    const result = await sh(`(sleep 1; touch ${marker}) & wait`, { timeoutMs: 100, killGraceMs: 100 });
    assert.equal(result.timedOut, true);
    await new Promise((resolve) => setTimeout(resolve, 1_400));
    assert.equal(existsSync(marker), false, "the child was killed with its parent");
  });

  it("caps captured output and flags truncation, while still streaming everything", async () => {
    let streamed = 0;
    const result = await sh("yes x | head -c 20000", { maxOutputBytes: 1000, onOutput: (chunk) => (streamed += chunk.text.length) });
    assert.equal(result.truncated, true);
    assert.ok(result.stdout.length <= 1000);
    assert.ok(streamed >= 20000, "the live stream is not capped here");
  });

  it("reports a program that cannot be started instead of throwing", async () => {
    const missing = await runProcess({ file: "/nonexistent/program", args: [], cwd: root, env: {}, timeoutMs: 1000 });
    assert.equal(missing.spawnError, "ENOENT");
    assert.equal(missing.code, null);

    const badDir = await runProcess({ file: "/bin/sh", args: ["-c", "true"], cwd: join(root, "no-such-dir"), env: {}, timeoutMs: 1000 });
    assert.equal(badDir.spawnError, "ENOENT");
  });

  it("does not interpret shell syntax in arguments when run without a shell", async () => {
    const result = await runProcess({ file: "/bin/echo", args: ["$(touch hacked); `touch hacked2`", ";", "rm", "-rf"], cwd: root, env: {}, timeoutMs: 1000 });
    assert.equal(result.stdout.trim(), "$(touch hacked); `touch hacked2` ; rm -rf");
    assert.equal(existsSync(join(root, "hacked")), false);
    assert.equal(existsSync(join(root, "hacked2")), false);
  });
});
