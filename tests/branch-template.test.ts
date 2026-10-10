import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_BRANCH_TEMPLATE,
  DEFAULT_EXEMPT_BRANCHES,
  MAX_TEMPLATE_LENGTH,
  SAMPLE_VALUES,
  TemplateRenderError,
  checkBranchName,
  dateValues,
  isValidBranchName,
  normalizeVersion,
  parseTemplate,
  renderBranchName,
  sanitizeSlug,
  templateToMatcher,
  templateTokens,
  validateTemplate
} from "@shared/branch-template";

describe("parseTemplate", () => {
  it("splits literals and tokens", () => {
    const parsed = parseTemplate(DEFAULT_BRANCH_TEMPLATE);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.parts, [
      { kind: "text", text: "v" },
      { kind: "token", name: "version" },
      { kind: "text", text: "_" },
      { kind: "token", name: "year" },
      { kind: "text", text: "_" },
      { kind: "token", name: "mmdd" }
    ]);
    assert.deepEqual(templateTokens(parsed.parts), ["version", "year", "mmdd"]);
  });

  it("reports unknown tokens and unbalanced braces", () => {
    const unknown = parseTemplate("v{versoin}_{year}");
    assert.ok(!unknown.ok);
    assert.ok(unknown.errors[0]?.includes("versoin"));
    assert.ok(!parseTemplate("v{version").ok);
    assert.ok(!parseTemplate("v}version{").ok);
    assert.ok(!parseTemplate("{}").ok);
  });
});

describe("validateTemplate", () => {
  it("accepts the default and other sensible templates", () => {
    for (const template of [DEFAULT_BRANCH_TEMPLATE, "{user}/{type}/{slug}", "feature/{mmdd}-{seq}", "wip-{slug}"]) {
      assert.equal(validateTemplate(template).ok, true, template);
    }
  });

  it("rejects empty, too long, non-string and unknown-token templates", () => {
    for (const bad of ["", "   ", "x".repeat(MAX_TEMPLATE_LENGTH + 1), 5, null, "{nope}"]) {
      assert.equal(validateTemplate(bad).ok, false, String(bad));
    }
  });

  it("requires something that changes between uses", () => {
    const result = validateTemplate("v{version}_{user}");
    assert.ok(!result.ok);
    assert.ok(result.errors.some((error) => error.includes("會變動")));
    assert.equal(validateTemplate("fixed-name").ok, false);
  });

  it("rejects templates that can never produce a legal git branch name", () => {
    for (const bad of ["my branch {slug}", "{slug}~1", "{slug}:x", "{slug}..{seq}", "/{slug}", "{slug}/", "-{slug}", "{slug}.lock", "{slug}?"]) {
      assert.equal(validateTemplate(bad).ok, false, bad);
    }
  });
});

describe("renderBranchName", () => {
  it("renders the default template to the house convention", () => {
    assert.equal(
      renderBranchName(DEFAULT_BRANCH_TEMPLATE, { version: "010", year: "2026", mmdd: "1009" }),
      "v010_2026_1009"
    );
  });

  it("renders every token", () => {
    assert.equal(
      renderBranchName("{user}/{type}/{year}-{month}-{day}-{mmdd}-{version}-{seq}-{slug}", SAMPLE_VALUES),
      "alice/feat/2026-10-09-1009-010-1-login-page"
    );
  });

  it("refuses to render with a missing value or an illegal result", () => {
    assert.throws(() => renderBranchName("{slug}-{seq}", { slug: "x" }), TemplateRenderError);
    assert.throws(() => renderBranchName("{slug}", { slug: "a..b" }), TemplateRenderError);
    assert.throws(() => renderBranchName("{slug}", { slug: "has space" }), TemplateRenderError);
    assert.throws(() => renderBranchName("{broken", {}), TemplateRenderError);
  });
});

describe("version and date values", () => {
  it("normalises versions by dropping dots and prefixes", () => {
    assert.equal(normalizeVersion("0.1.0"), "010");
    assert.equal(normalizeVersion("v1.2.3"), "123");
    assert.equal(normalizeVersion("2.0.0-beta.1"), "200");
    assert.equal(normalizeVersion("  10 \n"), "10");
    assert.equal(normalizeVersion("latest"), null);
    assert.equal(normalizeVersion(""), null);
  });

  it("pads dates and handles year boundaries", () => {
    assert.deepEqual(dateValues(new Date(2026, 9, 9)), { year: "2026", month: "10", day: "09", mmdd: "1009" });
    assert.deepEqual(dateValues(new Date(2026, 0, 5)), { year: "2026", month: "01", day: "05", mmdd: "0105" });
    assert.deepEqual(dateValues(new Date(2025, 11, 31)), { year: "2025", month: "12", day: "31", mmdd: "1231" });
  });
});

describe("sanitizeSlug", () => {
  it("lowercases and joins words with single hyphens", () => {
    assert.equal(sanitizeSlug("Fix Login Page!"), "fix-login-page");
    assert.equal(sanitizeSlug("  --a--b--  "), "a-b");
    assert.equal(sanitizeSlug("a/b\\c:d"), "a-b-c-d");
  });

  it("keeps non-latin letters and rejects input with nothing usable", () => {
    assert.equal(sanitizeSlug("登入 頁面"), "登入-頁面");
    assert.equal(sanitizeSlug("!!! ???"), null);
    assert.equal(sanitizeSlug(""), null);
  });

  it("truncates without leaving a trailing hyphen", () => {
    const slug = sanitizeSlug(`${"a".repeat(49)} bbbb`);
    assert.equal(slug, "a".repeat(49));
    assert.ok((sanitizeSlug("x".repeat(200)) ?? "").length <= 50);
  });
});

describe("isValidBranchName", () => {
  it("accepts ordinary names", () => {
    for (const name of ["main", "v010_2026_1009", "feature/login", "alice/feat/x-1", "release/1.0", "登入"]) {
      assert.equal(isValidBranchName(name), true, name);
    }
  });

  it("rejects names git would refuse", () => {
    for (const name of [
      "", "HEAD", "@", "-x", "/x", "x/", "x.", "a b", "a..b", "a//b", "a@{b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b",
      "a\\b", "a\tb", ".hidden", "a/.hidden", "x.lock", "a/x.lock", "x".repeat(256)
    ]) {
      assert.equal(isValidBranchName(name), false, JSON.stringify(name));
    }
  });
});

describe("branch compliance check", () => {
  const rule = { template: DEFAULT_BRANCH_TEMPLATE, exempt: DEFAULT_EXEMPT_BRANCHES };

  it("accepts names built from the template", () => {
    assert.equal(checkBranchName("v010_2026_1009", rule), "ok");
    assert.equal(checkBranchName("v1_2025_0101", rule), "ok");
    assert.equal(checkBranchName("v0123_2026_1231", rule), "ok");
  });

  it("flags anything else", () => {
    for (const name of ["feature/login", "v010_2026_100", "V010_2026_1009", "v010-2026-1009", "v010_2026_1009_x", "wip", "xv010_2026_1009"]) {
      assert.equal(checkBranchName(name, rule), "violation", name);
    }
  });

  it("exempts default branches, including patterns", () => {
    assert.equal(checkBranchName("main", rule), "exempt");
    assert.equal(checkBranchName("develop", rule), "exempt");
    assert.equal(checkBranchName("release/1.0", rule), "exempt");
    assert.equal(checkBranchName("release", rule), "violation");
  });

  it("an empty exemption list exempts nothing", () => {
    assert.equal(checkBranchName("main", { template: DEFAULT_BRANCH_TEMPLATE, exempt: [] }), "violation");
  });

  it("works for templates with user, type and slug", () => {
    const custom = { template: "{user}/{type}/{slug}", exempt: [] };
    assert.equal(checkBranchName("alice/feat/login-page", custom), "ok");
    assert.equal(checkBranchName("alice/feature-work/login", custom), "violation");
    assert.equal(checkBranchName("alice/feat", custom), "violation");
  });

  it("does not treat regex metacharacters in the template literally as pattern syntax", () => {
    const rule2 = { template: "rel.{version}+x", exempt: [] };
    assert.equal(checkBranchName("rel.12+x", rule2), "ok");
    assert.equal(checkBranchName("relX12+x", rule2), "violation");
    assert.equal(checkBranchName("rel.12xx", rule2), "violation");
  });

  it("does not flag everything when the stored template is broken", () => {
    assert.equal(templateToMatcher("{broken"), null);
    assert.equal(checkBranchName("anything", { template: "{broken", exempt: [] }), "ok");
  });
});
