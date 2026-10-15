import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const MIN_FONT_PX = 14;
const css = readFileSync(join(process.cwd(), "src/renderer/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** 整份樣式表所有 font-size 宣告：回傳 [原文, 數值, 單位]。 */
const sizes = [...css.matchAll(/font-size:\s*([^;}]+)/g)].map((match) => {
  const raw = (match[1] ?? "").trim();
  const parsed = /^([\d.]+)(px|rem|em|%)?$/.exec(raw);
  return { raw, value: parsed ? Number(parsed[1]) : null, unit: parsed?.[2] ?? "" };
});

describe("minimum font size", () => {
  it("never declares a font size under 14px", () => {
    assert.ok(sizes.length > 0);
    for (const { raw, value, unit } of sizes) {
      if (value === null) continue;
      if (unit === "px") assert.ok(value >= MIN_FONT_PX, `font-size: ${raw}`);
      else if (unit === "rem" || unit === "em") assert.ok(value >= 1, `font-size: ${raw}`);
      else if (unit === "%") assert.ok(value >= 100, `font-size: ${raw}`);
    }
  });

  it("does not use keyword sizes that can shrink below 14px", () => {
    for (const { raw, value } of sizes) {
      if (value === null) assert.ok(!/^(x-small|xx-small|small|smaller)$/.test(raw), `font-size: ${raw}`);
    }
  });

  it("does not set a size through the font shorthand", () => {
    assert.ok(!/font:\s*[^;}]*\d(px|rem|em)/.test(css));
  });
});

describe("settings page spacing", () => {
  it("scopes the extra spacing under .settings-page", () => {
    assert.match(css, /\.settings-page\s*>\s*\.panel\s*\+\s*\.panel\s*\{[^}]*margin-top/);
    assert.match(css, /\.settings-page h3\s*\{[^}]*margin-top/);
    assert.match(css, /\.settings-page div\.row-actions[^{]*\{[^}]*margin/);
  });

  it("does not change .row-actions or .plain-list margins globally", () => {
    for (const selector of [".row-actions", ".plain-list"]) {
      const block = new RegExp(`(^|\\n)${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`).exec(css)?.[2] ?? "";
      assert.ok(!/margin-bottom/.test(block) || selector === ".plain-list", `${selector} gained a global margin-bottom`);
    }
  });
});
