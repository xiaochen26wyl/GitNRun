import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_GLOB_LENGTH, globToRegExp, matchGlob, matchesAnyGlob } from "@shared/glob";

describe("matchGlob (branch semantics: * crosses slashes)", () => {
  it("matches literals exactly", () => {
    assert.equal(matchGlob("main", "main"), true);
    assert.equal(matchGlob("main", "main2"), false);
    assert.equal(matchGlob("main", "xmain"), false);
  });

  it("treats * as 'anything', slashes included", () => {
    assert.equal(matchGlob("*", "feature/login"), true);
    assert.equal(matchGlob("feature/*", "feature/a/b"), true);
    assert.equal(matchGlob("release/*", "release/1.0"), true);
    assert.equal(matchGlob("release/*", "hotfix/1.0"), false);
    assert.equal(matchGlob("*-wip", "login-wip"), true);
  });

  it("treats ? as exactly one character", () => {
    assert.equal(matchGlob("v???_????_????", "v010_2026_1009"), true);
    assert.equal(matchGlob("v???_????_????", "v10_2026_1009"), false);
  });

  it("escapes regex metacharacters in the pattern", () => {
    assert.equal(matchGlob("a.b", "a.b"), true);
    assert.equal(matchGlob("a.b", "axb"), false);
    assert.equal(matchGlob("(x)+[y]", "(x)+[y]"), true);
    assert.equal(matchGlob("a|b", "a"), false);
    assert.equal(matchGlob("$^", "$^"), true);
  });
});

describe("matchGlob (path-aware)", () => {
  const opts = { pathAware: true };

  it("keeps * inside a path segment, and ** across segments", () => {
    assert.equal(matchGlob("src/*.ts", "src/a.ts", opts), true);
    assert.equal(matchGlob("src/*.ts", "src/deep/a.ts", opts), false);
    assert.equal(matchGlob("src/**.ts", "src/deep/a.ts", opts), true);
    assert.equal(matchGlob("src/**/a.ts", "src/x/y/a.ts", opts), true);
    assert.equal(matchGlob("a?c", "a/c", opts), false);
  });
});

describe("globToRegExp limits", () => {
  it("rejects empty and over-long patterns", () => {
    assert.equal(globToRegExp(""), null);
    assert.equal(globToRegExp("a".repeat(MAX_GLOB_LENGTH + 1)), null);
    assert.notEqual(globToRegExp("a".repeat(MAX_GLOB_LENGTH)), null);
  });

  it("collapses runs of * so a hostile pattern stays fast", () => {
    const start = performance.now();
    const result = matchGlob("*".repeat(150) + "x", "a".repeat(5000));
    assert.equal(result, false);
    assert.ok(performance.now() - start < 200);
  });
});

describe("matchesAnyGlob", () => {
  it("is true when any pattern matches and when there are no patterns", () => {
    assert.equal(matchesAnyGlob(["main", "dev*"], "develop"), true);
    assert.equal(matchesAnyGlob(["main", "dev*"], "feature"), false);
    assert.equal(matchesAnyGlob([], "anything"), true);
  });
});
