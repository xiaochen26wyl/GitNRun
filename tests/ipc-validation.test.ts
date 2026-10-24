import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IPC } from "@shared/ipc";
import {
  InvalidIpcInputError,
  MAX_IPC_STRING,
  asBoundedString,
  asDocumentOpenArgs,
  asDocumentRootArgs,
  asEnum,
  asExternalLinkArgs,
  asExternalUrl,
  asGitLiteOverviewArgs,
  asNoArgs,
  asRunAccountArgs,
  asRunActionArgs,
  asRunPasscodeBindingArgs,
  asRunTargetIdArgs,
  asSafeInteger,
  isKnownChannel,
  runValidated
} from "@main/ipc-validation";

describe("isKnownChannel", () => {
  it("accepts every declared channel", () => {
    for (const channel of Object.values(IPC)) {
      assert.equal(isKnownChannel(channel), true);
    }
  });

  it("rejects unknown channels and non-strings", () => {
    assert.equal(isKnownChannel("app:evil"), false);
    assert.equal(isKnownChannel("__proto__"), false);
    assert.equal(isKnownChannel(undefined), false);
    assert.equal(isKnownChannel(42), false);
  });
});

describe("asBoundedString", () => {
  it("accepts ordinary strings", () => {
    assert.equal(asBoundedString("main"), "main");
  });

  it("rejects non-strings", () => {
    for (const value of [null, undefined, 1, {}, [], true]) {
      assert.equal(asBoundedString(value), null);
    }
  });

  it("rejects over-long strings", () => {
    assert.equal(asBoundedString("a".repeat(MAX_IPC_STRING + 1)), null);
    assert.equal(asBoundedString("a".repeat(MAX_IPC_STRING)), "a".repeat(MAX_IPC_STRING));
    assert.equal(asBoundedString("abcd", { max: 3 }), null);
  });

  it("rejects empty strings unless allowed", () => {
    assert.equal(asBoundedString(""), null);
    assert.equal(asBoundedString("", { allowEmpty: true }), "");
  });

  it("rejects control characters unless allowed", () => {
    assert.equal(asBoundedString("a\nb"), null);
    assert.equal(asBoundedString("a\u0000b"), null);
    assert.equal(asBoundedString("a\nb", { allowControl: true }), "a\nb");
  });
});

describe("asSafeInteger", () => {
  it("enforces type and range", () => {
    assert.equal(asSafeInteger(15, 15, 3600), 15);
    assert.equal(asSafeInteger(14, 15, 3600), null);
    assert.equal(asSafeInteger(3601, 15, 3600), null);
    assert.equal(asSafeInteger(20.5, 15, 3600), null);
    assert.equal(asSafeInteger("20", 15, 3600), null);
    assert.equal(asSafeInteger(Number.NaN, 15, 3600), null);
  });
});

describe("asEnum", () => {
  it("only accepts listed values", () => {
    assert.equal(asEnum("table", ["table", "card"] as const), "table");
    assert.equal(asEnum("grid", ["table", "card"] as const), null);
    assert.equal(asEnum(1, ["table", "card"] as const), null);
  });
});

describe("runValidated", () => {
  it("does not call the handler when validation fails", async () => {
    let called = false;
    await assert.rejects(
      runValidated(asNoArgs, ["unexpected"], () => {
        called = true;
      }),
      InvalidIpcInputError
    );
    assert.equal(called, false);
  });

  it("passes validated arguments to the handler", async () => {
    const result = await runValidated(
      (args): [string] | null => {
        const name = asBoundedString(args[0]);
        return name === null ? null : [name];
      },
      ["gitnrun"],
      (name: string) => `hello ${name}`
    );
    assert.equal(result, "hello gitnrun");
  });
});

describe("run page arguments", () => {
  it("declares the run channels", () => {
    for (const channel of ["run:overview", "run:action", "run:add-folder", "run:remove-folder", "run:set-account", "run:copy-passcode", "run:scan-ports", "run:release-ports"]) {
      assert.equal(isKnownChannel(channel), true, channel);
    }
  });

  it("accepts only a target id plus a known action object", () => {
    for (const action of ["release-backend", "release-all", "start-backend"] as const) {
      assert.deepEqual(asRunActionArgs(["p:3", { scope: "project", action }]), ["p:3", { scope: "project", action }]);
    }
    assert.deepEqual(asRunActionArgs(["p:3", { scope: "project", action: "readme" }]), ["p:3", { scope: "project", action: "readme" }]);
    assert.deepEqual(asRunActionArgs(["p:3", { scope: "service", service: "api", action: "release" }]), ["p:3", { scope: "service", service: "api", action: "release" }]);
    assert.equal(asRunActionArgs(["p:3", { scope: "project", action: "release" }]), null);
    assert.deepEqual(asRunActionArgs(["p:3", { scope: "project", action: "reinstall" }]), ["p:3", { scope: "project", action: "reinstall" }]);
    assert.deepEqual(asRunActionArgs(["f:12", { scope: "service", service: "web", action: "web" }]), [
      "f:12",
      { scope: "service", service: "web", action: "web" }
    ]);
    for (const [scope, action] of [["project", "stop"], ["project", "stop-backend"], ["service", "stop"], ["service", "restart"]] as const) {
      const raw = scope === "project" ? { scope, action } : { scope, service: "flutter-web", action };
      assert.equal(asRunActionArgs(["p:3", raw]), null, `${scope}:${action}`);
    }
  });

  it("rejects extra, missing, mistyped or unknown arguments", () => {
    for (const args of [
      [],
      ["p:3"],
      ["p:3", { scope: "service", service: "web", action: "start" }, "extra"],
      ["p:3", "all"],
      ["p:3", "rm -rf /"],
      ["p:3", { scope: "project", action: "start" }],
      ["p:3", { scope: "project", action: "stop", service: "web" }],
      ["p:3", { scope: "project", action: "readme", path: "/etc/passwd" }],
      ["p:3", { scope: "project", action: "reinstall", command: "rm -rf /" }],
      ["p:3", { scope: "service", service: "web", action: "reinstall" }],
      ["p:3", { scope: "service", service: "web", action: "readme" }],
      ["p:3", { scope: "service", service: "Web", action: "start" }],
      ["p:3", { scope: "service", service: "web", action: "desktop" }],
      ["p:3", { scope: "service", service: "flutter", action: "hot-reload" }],
      ["p:3", { scope: "service", service: "flutter", action: "hot-restart" }],
      ["p:3", { scope: "service", service: "web", action: "start", command: "pnpm dev" }],
      ["../../etc", { scope: "service", service: "web", action: "start" }],
      ["p:0", { scope: "service", service: "web", action: "start" }],
      [3, { scope: "service", service: "web", action: "start" }],
      ["p:3", 1],
      [{ id: "p:3" }, { scope: "service", service: "web", action: "start" }]
    ]) {
      assert.equal(asRunActionArgs(args), null, JSON.stringify(args));
    }
  });

  it("accepts a bare target id only in the right shape", () => {
    assert.deepEqual(asRunTargetIdArgs(["f:2"]), ["f:2"]);
    for (const args of [[], ["f:2", "x"], ["/Users/me"], [2], ["f:"]]) {
      assert.equal(asRunTargetIdArgs(args), null, JSON.stringify(args));
    }
  });

  it("accepts a target id with an account, trimmed, and an empty account to clear it", () => {
    assert.deepEqual(asRunAccountArgs(["p:3", "tester@example.com"]), ["p:3", "tester@example.com"]);
    assert.deepEqual(asRunAccountArgs(["f:2", "  alice  "]), ["f:2", "alice"]);
    assert.deepEqual(asRunAccountArgs(["p:3", ""]), ["p:3", ""]);
    assert.deepEqual(asRunAccountArgs(["p:3", "   "]), ["p:3", ""]);
    assert.deepEqual(asRunAccountArgs(["p:3", "x".repeat(200)]), ["p:3", "x".repeat(200)]);
  });

  it("rejects an account that is too long, has control characters, or comes with the wrong shape", () => {
    for (const args of [
      [],
      ["p:3"],
      ["p:3", "alice", "extra"],
      ["p:3", "x".repeat(201)],
      ["p:3", "a\nb"],
      ["p:3", "a\u0000b"],
      ["p:3", 42],
      ["p:3", null],
      ["../x", "alice"],
      ["p:0", "alice"],
      [3, "alice"]
    ]) {
      assert.equal(asRunAccountArgs(args), null, JSON.stringify(args));
    }
  });
});

describe("asRunPasscodeBindingArgs", () => {
  it("accepts a target id with a safe environment file and key", () => {
    assert.deepEqual(asRunPasscodeBindingArgs(["p:3", { file: ".dev.vars", key: "DEBUG_AUTH_PASSWORD" }]), ["p:3", { file: ".dev.vars", key: "DEBUG_AUTH_PASSWORD" }]);
    assert.deepEqual(asRunPasscodeBindingArgs(["f:123456789", { file: "apps/edge/.env.local", key: "DEBUG_PASSWORD" }]), ["f:123456789", { file: "apps/edge/.env.local", key: "DEBUG_PASSWORD" }]);
  });

  it("rejects unsafe paths, public keys, extra fields and the wrong shape", () => {
    for (const args of [
      [],
      ["p:3"],
      ["p:3", { file: ".env", key: "DEBUG_PASSWORD" }, "extra"],
      ["x:3", { file: ".env", key: "DEBUG_PASSWORD" }],
      ["p:3", null],
      ["p:3", ".env"],
      ["p:3", [".env", "DEBUG_PASSWORD"]],
      ["p:3", { file: ".env" }],
      ["p:3", { file: ".env", key: "DEBUG_PASSWORD", value: "secret" }],
      ["p:3", { file: "/etc/.env", key: "DEBUG_PASSWORD" }],
      ["p:3", { file: "../.env", key: "DEBUG_PASSWORD" }],
      ["p:3", { file: "config.json", key: "DEBUG_PASSWORD" }],
      ["p:3", { file: ".env", key: "debug_password" }],
      ["p:3", { file: ".env", key: "NEXT_PUBLIC_DEBUG_PASSWORD" }],
      ["p:3", { file: 42, key: "DEBUG_PASSWORD" }]
    ]) {
      assert.equal(asRunPasscodeBindingArgs(args), null, JSON.stringify(args));
    }
  });
});

describe("asDocumentOpenArgs", () => {
  it("accepts saved shortcut ids (positive) and auto-discovered README ids (negative)", () => {
    assert.deepEqual(asDocumentOpenArgs([1]), [1]);
    assert.deepEqual(asDocumentOpenArgs([-1]), [-1]);
    assert.deepEqual(asDocumentOpenArgs([-37]), [-37]);
  });

  it("rejects zero, non-integers, non-numbers and the wrong arity", () => {
    for (const args of [[], [0], [1.5], [-0.5], ["1"], [null], [Number.NaN], [Infinity], [2 ** 31], [-(2 ** 31)], [1, 2]]) {
      assert.equal(asDocumentOpenArgs(args), null, JSON.stringify(args));
    }
  });
});

describe("asDocumentRootArgs", () => {
  it("accepts a path or an empty string (auto-scan off) and trims whitespace", () => {
    assert.deepEqual(asDocumentRootArgs(["/Users/me/code"]), ["/Users/me/code"]);
    assert.deepEqual(asDocumentRootArgs(["  /Users/me/code  "]), ["/Users/me/code"]);
    assert.deepEqual(asDocumentRootArgs([""]), [""]);
  });

  it("rejects non-strings, control characters, overlong paths and the wrong arity", () => {
    for (const args of [[], [null], [1], ["/a\u0000b"], ["x".repeat(MAX_IPC_STRING + 1)], ["/a", "/b"]]) {
      assert.equal(asDocumentRootArgs(args), null, JSON.stringify(args));
    }
  });
});

describe("asGitLiteOverviewArgs", () => {
  it("accepts no argument, or exactly { issues: boolean }", () => {
    assert.deepEqual(asGitLiteOverviewArgs([]), []);
    assert.deepEqual(asGitLiteOverviewArgs([{ issues: false }]), [{ issues: false }]);
    assert.deepEqual(asGitLiteOverviewArgs([{ issues: true }]), [{ issues: true }]);
  });

  it("rejects anything else, including extra keys and the wrong arity", () => {
    for (const args of [
      [undefined],
      [null],
      ["issues"],
      [[true]],
      [{}],
      [{ issues: "no" }],
      [{ issues: 0 }],
      [{ issues: false, extra: 1 }],
      [{ other: true }],
      [{ issues: true }, { issues: true }]
    ]) {
      assert.equal(asGitLiteOverviewArgs(args), null, JSON.stringify(args));
    }
  });
});

describe("asExternalUrl / asExternalLinkArgs", () => {
  it("accepts https://github.com/settings/ pages and returns the normalized URL", () => {
    const url = "https://github.com/settings/personal-access-tokens/new";
    assert.equal(asExternalUrl(url), url);
    assert.deepEqual(asExternalLinkArgs([url]), [url]);
    assert.equal(asExternalUrl("https://github.com/settings/tokens?type=beta"), "https://github.com/settings/tokens?type=beta");
  });

  it("rejects other hosts, schemes, ports, credentials and look-alike hosts", () => {
    for (const value of [
      "http://github.com/settings/tokens",
      "https://evil.com/settings/tokens",
      "https://github.com.evil.com/settings/tokens",
      "https://api.github.com/settings/tokens",
      "https://github.com:8443/settings/tokens",
      "https://user:pw@github.com/settings/tokens",
      "https://github.com\\@evil.com/settings/tokens",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "ftp://github.com/settings/tokens"
    ]) {
      assert.equal(asExternalUrl(value), null, value);
    }
  });

  it("rejects paths outside /settings/, including traversal out of it", () => {
    for (const value of [
      "https://github.com/",
      "https://github.com/settings",
      "https://github.com/octocat/repo",
      "https://github.com/settings/../octocat",
      "https://github.com/settings/%2e%2e/octocat",
      "https://github.com/login/oauth/authorize"
    ]) {
      assert.equal(asExternalUrl(value), null, value);
    }
  });

  it("accepts a repo's issue list and a single issue page", () => {
    for (const url of [
      "https://github.com/xiaochen26wyl/fictionPurr/issues",
      "https://github.com/xiaochen26wyl/fictionPurr/issues/44",
      "https://github.com/acme/widgets.js/issues/7",
      "https://github.com/acme/my_repo-2/issues"
    ]) {
      assert.equal(asExternalUrl(url), url, url);
      assert.deepEqual(asExternalLinkArgs([url]), [url], url);
    }
  });

  it("rejects other repo pages, query strings, hashes, dot segments and malformed issue paths", () => {
    for (const value of [
      "https://github.com/acme/widgets",
      "https://github.com/acme/widgets/pulls",
      "https://github.com/acme/widgets/pull/7",
      "https://github.com/acme/widgets/wiki",
      "https://github.com/acme/widgets/issues/",
      "https://github.com/acme/widgets/issues/7/comments",
      "https://github.com/acme/widgets/issues/seven",
      "https://github.com/acme/widgets/issues/12345678901",
      "https://github.com/acme/widgets/issues?q=is%3Aopen",
      "https://github.com/acme/widgets/issues/7#issuecomment-1",
      "https://github.com/acme/widgets/issues#top",
      "https://github.com/acme/widgets/../other/issues",
      "https://github.com/acme/widgets/x/../issues",
      "https://github.com/acme/widgets/%2e%2e/issues",
      "https://github.com/acme/./widgets/issues",
      "https://github.com/-acme/widgets/issues",
      "https://github.com/acme/wid%67ets/issues",
      "https://github.com/acme/../issues",
      "https://github.com//widgets/issues",
      "https://github.com/acme/widgets/issues/7\u0000",
      `https://github.com/acme/${"r".repeat(101)}/issues`,
      "https://github.com:8443/acme/widgets/issues",
      "https://user:pw@github.com/acme/widgets/issues",
      "http://github.com/acme/widgets/issues",
      "https://evil.com/acme/widgets/issues",
      "https://api.github.com/acme/widgets/issues"
    ]) {
      assert.equal(asExternalUrl(value), null, value);
    }
  });

  it("rejects non-strings, control characters, overlong input and the wrong arity", () => {
    for (const args of [
      [],
      [null],
      [42],
      [""],
      ["https://github.com/settings/tokens\n"],
      ["https://github.com/settings/" + "a".repeat(300)],
      ["https://github.com/settings/tokens", "https://github.com/settings/tokens"]
    ]) {
      assert.equal(asExternalLinkArgs(args), null, JSON.stringify(args));
    }
  });
});
