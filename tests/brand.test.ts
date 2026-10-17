import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isBrandColor, lookupBrandColor, lookupHeadPalette, normalizeBrandColor, parseBrandColor, projectHeadProps } from "@shared/brand";

const stockPaw = `# StockPaw

## 品牌配色

本節依據色票展示頁，列出選用的色票。

> **維護規則**：新增、修改或刪除色票時，必須同步更新本節。

### 主要配色（Logo 取色）

| 角色 | 色碼 | 說明 |
|---|---|---|
| Primary 主橘 | \`#F88800\` | 品牌主橘、主要 CTA |
| Secondary 品牌藍 | \`#6195F4\` | 次要實心鈕 |

### 白天模式選用色

| 色票 | 色碼 |
|---|---|
| 紅 | \`#FF0000\` |
`;

const fictionPurr = `## 品牌配色

### 主要配色（Logo 取色）

| 角色 | 色碼 | 說明 |
|---|---|---|
| Primary 主色 | \`#0066CC\` | 主 CTA |
| Secondary 次色 | \`#FB7185\` | 次要強調 |
`;

const toBloom = `## 品牌配色

### 主要配色（Logo 取色）

| 角色 | 色碼 | 說明 |
|---|---|---|
| Brand 品牌綠 | \`#009F93\` | App 主色 |
| Canvas 畫布 | \`#000000\` | 頁面背景 |
`;

const xiaochenStudio = `## 品牌配色

### 主要配色（Logo 取色）

| 角色 | 淺色 | 深色 | 說明 |
|---|---|---|---|
| Accent 品牌藍 | \`#0071E3\` | \`#2997FF\` | 品牌強調色 |
| 背景 | \`#FFFFFF\` | \`#000000\` | 頁面底色 |
`;

describe("parseBrandColor", () => {
  it("takes the first color of the first primary-palette row in the real README layouts", () => {
    assert.equal(parseBrandColor(stockPaw), "#F88800");
    assert.equal(parseBrandColor(fictionPurr), "#0066CC");
    assert.equal(parseBrandColor(toBloom), "#009F93");
  });

  it("uses the light column when the table has light and dark columns", () => {
    assert.equal(parseBrandColor(xiaochenStudio), "#0071E3");
  });

  it("normalizes lowercase and three-digit codes to uppercase six digits", () => {
    const table = (code: string) => `## 品牌配色\n\n### 主要配色\n\n| 角色 | 色碼 |\n|---|---|\n| 主色 | \`${code}\` |\n`;
    assert.equal(parseBrandColor(table("#f88800")), "#F88800");
    assert.equal(parseBrandColor(table("#0cf")), "#00CCFF");
  });

  it("never reads the header or separator row as data", () => {
    const markdown = "## 品牌配色\n\n### 主要配色\n\n| 角色 | 色碼 |\n|:---|:---:|\n| 主色 | `#123456` |\n";
    assert.equal(parseBrandColor(markdown), "#123456");
  });

  it("returns null without a brand section, without a primary section, or without a valid color", () => {
    assert.equal(parseBrandColor("# 專案\n\n沒有色票。"), null);
    assert.equal(parseBrandColor("## 品牌配色\n\n### 完整色票\n\n| 角色 | 色碼 |\n|---|---|\n| 主色 | `#123456` |\n"), null);
    assert.equal(parseBrandColor("## 品牌配色\n\n### 主要配色\n\n| 角色 | 色碼 |\n|---|---|\n| 主色 | 待定 |\n"), null);
    assert.equal(parseBrandColor("## 品牌配色\n\n### 主要配色\n\n| 角色 | 色碼 |\n|---|---|\n| 主色 | `#GG0000` |\n"), null);
    assert.equal(parseBrandColor("## 品牌配色\n\n### 主要配色\n\n| 角色 | 色碼 |\n|---|---|\n| 主色 | `red` |\n"), null);
  });

  it("does not look past the end of the brand section", () => {
    const markdown = "## 品牌配色\n\n沒有主要配色。\n\n## 其他\n\n### 主要配色\n\n| 角色 | 色碼 |\n|---|---|\n| 主色 | `#123456` |\n";
    assert.equal(parseBrandColor(markdown), null);
  });

  it("handles CRLF line endings", () => {
    assert.equal(parseBrandColor(fictionPurr.replace(/\n/g, "\r\n")), "#0066CC");
  });
});

describe("normalizeBrandColor / isBrandColor", () => {
  it("accepts only a single well-formed color", () => {
    assert.equal(normalizeBrandColor("#abc"), "#AABBCC");
    assert.equal(normalizeBrandColor("#0066cc"), "#0066CC");
    assert.equal(normalizeBrandColor("#0066CCAA"), null);
    assert.equal(normalizeBrandColor("0066CC"), null);
    assert.equal(isBrandColor("#0066CC"), true);
    assert.equal(isBrandColor("#0066cc"), false);
    assert.equal(isBrandColor("#abc"), false);
    assert.equal(isBrandColor(null), false);
  });
});

describe("lookupBrandColor / projectHeadProps", () => {
  const colors = { "/work/stockPaw": "#F88800", "/work/fictionPurr": "#0066CC" };

  it("matches a folder regardless of a trailing slash", () => {
    assert.equal(lookupBrandColor(colors, "/work/stockPaw/"), "#F88800");
    assert.equal(lookupBrandColor(colors, "/work/stockPaw"), "#F88800");
  });

  it("falls back to the parent folder for a README file path", () => {
    assert.equal(lookupBrandColor(colors, "/work/fictionPurr/README.md"), "#0066CC");
  });

  it("returns null for unknown, empty or root paths", () => {
    assert.equal(lookupBrandColor(colors, "/work/other"), null);
    assert.equal(lookupBrandColor(colors, "/work/other/README.md"), null);
    assert.equal(lookupBrandColor(colors, ""), null);
    assert.equal(lookupBrandColor(colors, null), null);
    assert.equal(lookupBrandColor(colors, undefined), null);
    assert.equal(lookupBrandColor(colors, "/"), null);
  });

  it("keeps the plain project-head when there is no brand color", () => {
    assert.deepEqual(projectHeadProps(colors, "/work/other"), { className: "project-head" });
  });

  it("uses the README color with white text when the project has no assigned palette", () => {
    assert.deepEqual(projectHeadProps(colors, "/work/stockPaw"), {
      className: "project-head branded",
      style: { "--brand": "#F88800", "--brand-fg": "#FFFFFF" }
    });
  });
});

describe("assigned head palettes", () => {
  it("gives toBloom a black bar with yellow text", () => {
    assert.deepEqual(projectHeadProps({}, "/work/toBloom"), {
      className: "project-head branded",
      style: { "--brand": "#000000", "--brand-fg": "#FFD93D" }
    });
  });

  it("matches the folder name regardless of case", () => {
    assert.deepEqual(lookupHeadPalette("/work/toBLoom"), lookupHeadPalette("/work/tobloom"));
    assert.deepEqual(lookupHeadPalette("/work/YUMEAEGIS/"), { background: "#EA580C", text: "#FFFFFF" });
  });

  it("falls back to the parent folder for a README file path", () => {
    assert.deepEqual(lookupHeadPalette("/work/Usage-Pulse/README.md"), { background: "#4C1D95", text: "#FFFFFF" });
  });

  it("puts the creator family on a white bar with black text and a black outline, and xiaochenStudio on the primary color", () => {
    for (const name of ["fictionPurr", "mahoPurr-Catalyst", "translationService"]) {
      assert.deepEqual(lookupHeadPalette(`/work/${name}`), { background: "#FFFFFF", text: "#000000", border: "#000000" }, name);
    }
    assert.equal(lookupHeadPalette("/work/xiaochenStudio")?.background, "#0066CC");
  });

  it("adds the outline variable only for palettes that have an outline", () => {
    assert.deepEqual(projectHeadProps({}, "/work/fictionPurr/README.md").style, {
      "--brand": "#FFFFFF",
      "--brand-fg": "#000000",
      "--brand-border": "#000000"
    });
    assert.equal(projectHeadProps({}, "/work/xiaochenStudio").style?.["--brand-border"], undefined);
  });

  it("wins over the README color", () => {
    const style = projectHeadProps({ "/work/yumeAegis": "#123456" }, "/work/yumeAegis").style;
    assert.equal(style?.["--brand"], "#EA580C");
  });

  it("ignores projects that are not in the table, empty paths and the root", () => {
    assert.equal(lookupHeadPalette("/work/other"), null);
    assert.equal(lookupHeadPalette(""), null);
    assert.equal(lookupHeadPalette(null), null);
    assert.equal(lookupHeadPalette("/"), null);
  });
});
