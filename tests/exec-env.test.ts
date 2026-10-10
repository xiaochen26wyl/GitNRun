import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PushEvent } from "@shared/events";
import {
  FALLBACK_PATH,
  GIT_ALLOWED_PROTOCOLS,
  PATH_PROBE_ARGS,
  buildBaseEnv,
  eventEnv,
  parsePathFromShellOutput,
  resolveLoginPath
} from "@main/exec/env";

const SECRET = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

describe("buildBaseEnv", () => {
  const source = {
    HOME: "/Users/me", USER: "me", SHELL: "/bin/zsh", LANG: "en_US.UTF-8", SSH_AUTH_SOCK: "/tmp/agent.sock",
    PATH: "/usr/bin:/bin",
    GITHUB_TOKEN: SECRET, ANTHROPIC_API_KEY: "sk-ant-x", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--require /evil.js", DYLD_INSERT_LIBRARIES: "/evil.dylib"
  };

  it("passes through only a small allowlist, never the app's other variables", () => {
    const env = buildBaseEnv(source, null);
    assert.equal(env.HOME, "/Users/me");
    assert.equal(env.SSH_AUTH_SOCK, "/tmp/agent.sock");
    for (const leaked of ["GITHUB_TOKEN", "ANTHROPIC_API_KEY", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "DYLD_INSERT_LIBRARIES"]) {
      assert.equal(env[leaked], undefined, leaked);
    }
    assert.ok(!JSON.stringify(env).includes(SECRET));
  });

  it("prefers the login shell's PATH, then the app's, then a sane fallback", () => {
    assert.equal(buildBaseEnv(source, "/opt/homebrew/bin:/usr/bin").PATH, "/opt/homebrew/bin:/usr/bin");
    assert.equal(buildBaseEnv(source, null).PATH, "/usr/bin:/bin");
    assert.equal(buildBaseEnv({ HOME: "/h" }, null).PATH, FALLBACK_PATH);
  });

  it("turns off prompts and pagers and blocks command-running git transports", () => {
    const env = buildBaseEnv({}, null);
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(env.GIT_ALLOW_PROTOCOL, GIT_ALLOWED_PROTOCOLS);
    assert.ok(!GIT_ALLOWED_PROTOCOLS.includes("ext"));
    assert.equal(env.GIT_PAGER, "cat");
    assert.equal(env.TERM, "dumb");
  });
});

describe("eventEnv", () => {
  const event = {
    branch: "feature/x", ref: "refs/heads/feature/x", eventType: "push", pusher: "alice",
    headMessage: "feat: $(rm -rf /)\nsecond line", afterSha: "a".repeat(40), beforeSha: null,
    fileCount: 3, commits: [{}, {}]
  } as unknown as PushEvent;

  it("hands event data over verbatim as plain strings", () => {
    const env = eventEnv(event, { name: "acme/api", localPath: "/Users/me/api" });
    assert.equal(env.PW_BRANCH, "feature/x");
    assert.equal(env.PW_PUSHER, "alice");
    assert.equal(env.PW_MESSAGE, "feat: $(rm -rf /)\nsecond line");
    assert.equal(env.PW_SHA, "a".repeat(40));
    assert.equal(env.PW_BEFORE_SHA, "");
    assert.equal(env.PW_FILE_COUNT, "3");
    assert.equal(env.PW_COMMIT_COUNT, "2");
    assert.equal(env.PW_LOCAL_PATH, "/Users/me/api");
  });

  it("strips NUL bytes and bounds long values", () => {
    const env = eventEnv({ ...event, headMessage: `a\0b${"x".repeat(10_000)}`, pusher: null }, { name: "p", localPath: null });
    assert.ok(!env.PW_MESSAGE?.includes("\0"));
    assert.equal(env.PW_MESSAGE?.length, 4000);
    assert.equal(env.PW_PUSHER, "");
    assert.equal(env.PW_LOCAL_PATH, "");
  });
});

describe("login shell PATH", () => {
  it("extracts the PATH between the markers and ignores profile noise", () => {
    const output = "Last login: today\nwelcome!\n__PW_PATH__/opt/homebrew/bin:/usr/bin:/bin__PW_PATH__\nbye";
    assert.equal(parsePathFromShellOutput(output), "/opt/homebrew/bin:/usr/bin:/bin");
  });

  it("rejects missing markers, empty or multi-line values and relative paths", () => {
    for (const bad of ["", "no markers", "__PW_PATH__", "__PW_PATH____PW_PATH__", "__PW_PATH__/a\n/b__PW_PATH__", "__PW_PATH__relative/bin__PW_PATH__"]) {
      assert.equal(parsePathFromShellOutput(bad), null, JSON.stringify(bad));
    }
  });

  it("asks the login shell and falls back to null on any failure", async () => {
    let asked: readonly string[] = [];
    const ok = await resolveLoginPath(async (file, args) => {
      asked = [file, ...args];
      return { code: 0, stdout: "__PW_PATH__/opt/bin:/usr/bin__PW_PATH__" };
    });
    assert.equal(ok, "/opt/bin:/usr/bin");
    assert.deepEqual(asked, ["/bin/zsh", ...PATH_PROBE_ARGS]);

    assert.equal(await resolveLoginPath(async () => ({ code: 1, stdout: "__PW_PATH__/a__PW_PATH__" })), null);
    assert.equal(await resolveLoginPath(async () => ({ code: 0, stdout: "garbage" })), null);
    assert.equal(await resolveLoginPath(async () => { throw new Error("timeout"); }), null);
  });
});
