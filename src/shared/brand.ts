/** 專案品牌色：從各專案 README 解析主色、專案名稱列的指定配色、依路徑查找（純函式，不依賴 DOM／Node）。 */

import { normalizeFolderPath } from "@shared/launcher";

/** 資料夾（已正規化）→ 大寫 #RRGGBB。 */
export type BrandColorMap = Readonly<Record<string, string>>;

const HEX = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const SEPARATOR_ROW = /^\|[\s:|-]+$/;
const FULL_COLOR = /^#[0-9A-F]{6}$/;

/** 品牌色定義的位置：「品牌配色」區塊底下的「主要配色」子區塊。 */
const SECTION_TITLE = "品牌配色";
const PRIMARY_TITLE = "主要配色";

/** 沒有專案指定字色時，色條上的文字一律白色。 */
const HEAD_TEXT_DEFAULT = "#FFFFFF";

export const isBrandColor = (value: unknown): value is string => typeof value === "string" && FULL_COLOR.test(value);

/** 把 #abc、#aabbcc 統一成大寫 #RRGGBB；格式不合回傳 null。 */
export const normalizeBrandColor = (raw: string): string | null => {
  const match = HEX.exec(raw);
  if (match === null || match[0] !== raw.trim()) {
    return null;
  }
  const digits = raw.trim().slice(1).toUpperCase();
  return `#${digits.length === 3 ? [...digits].map((digit) => digit + digit).join("") : digits}`;
};

const headingOf = (line: string): { level: number; title: string } | null => {
  const match = HEADING.exec(line.trim());
  const [, hashes = "", title = ""] = match ?? [];
  return match === null ? null : { level: hashes.length, title };
};

/**
 * 取「品牌配色 → 主要配色」表格第一列資料的第一個色碼（淺色／深色雙欄時就是淺色）。
 * 找不到區塊、表格或合法色碼一律回傳 null，不去「完整色票」撈別的顏色。
 */
export const parseBrandColor = (markdown: string): string | null => {
  const lines = markdown.split(/\r?\n/);
  const sectionIndex = lines.findIndex((line) => {
    const heading = headingOf(line);
    return heading !== null && heading.title.includes(SECTION_TITLE);
  });
  if (sectionIndex === -1) {
    return null;
  }
  const sectionLevel = headingOf(lines[sectionIndex] ?? "")?.level ?? 1;

  let primaryLevel = 0;
  let inTable = false;
  const rows: string[] = [];
  for (const line of lines.slice(sectionIndex + 1)) {
    const heading = headingOf(line);
    if (heading !== null) {
      if (primaryLevel === 0 && heading.level <= sectionLevel) {
        return null;
      }
      if (primaryLevel === 0 && heading.title.includes(PRIMARY_TITLE)) {
        primaryLevel = heading.level;
        continue;
      }
      if (primaryLevel > 0 && heading.level <= primaryLevel) {
        break;
      }
    }
    if (primaryLevel === 0) {
      continue;
    }
    const text = line.trim();
    if (text.startsWith("|")) {
      inTable = true;
      if (!SEPARATOR_ROW.test(text)) {
        rows.push(text);
      }
    } else if (inTable) {
      break;
    }
  }

  // 第一列是表頭，第二列起才是資料。
  const dataRow = rows[1];
  if (dataRow === undefined) {
    return null;
  }
  const match = HEX.exec(dataRow);
  return match === null ? null : normalizeBrandColor(match[0]);
};

/** 先查路徑本身，查不到再查上一層資料夾（文件空間的自動 README 捷徑指向 README 檔）。 */
export const lookupBrandColor = (colors: BrandColorMap, path: string | null | undefined): string | null => {
  if (!path) {
    return null;
  }
  const normalized = normalizeFolderPath(path);
  const direct = colors[normalized];
  if (direct !== undefined) {
    return direct;
  }
  const slash = normalized.lastIndexOf("/");
  const parent = slash > 0 ? normalized.slice(0, slash) : slash === 0 ? "/" : null;
  return parent === null ? null : (colors[parent] ?? null);
};

/** 專案名稱列的底色與字色。 */
export interface HeadPalette {
  background: string;
  text: string;
}

/**
 * 專案名稱列的指定配色，優先於 README 主色；key 是資料夾名稱（小寫）。
 * 色碼來源：toBloom 取自其 README 的 Canvas 畫布與 Ring Yellow 點綴黃；fictionPurr 系列共用
 * fictionPurr README 的 Secondary 次色，xiaochenStudio 用其 Primary 主色；Usage-Pulse 與 yumeAegis 由使用者指定色系。
 */
const HEAD_PALETTES: Readonly<Record<string, HeadPalette>> = {
  tobloom: { background: "#000000", text: "#FFD93D" },
  fictionpurr: { background: "#FB7185", text: HEAD_TEXT_DEFAULT },
  "mahopurr-catalyst": { background: "#FB7185", text: HEAD_TEXT_DEFAULT },
  translationservice: { background: "#FB7185", text: HEAD_TEXT_DEFAULT },
  xiaochenstudio: { background: "#0066CC", text: HEAD_TEXT_DEFAULT },
  "usage-pulse": { background: "#4C1D95", text: HEAD_TEXT_DEFAULT },
  yumeaegis: { background: "#EA580C", text: HEAD_TEXT_DEFAULT }
};

/** 依資料夾名稱（不分大小寫）查指定配色；查不到再查上一層資料夾（文件空間的 README 捷徑），與 README 色的查找規則一致。 */
export const lookupHeadPalette = (path: string | null | undefined): HeadPalette | null => {
  if (!path) {
    return null;
  }
  const segments = normalizeFolderPath(path).split("/").filter((segment) => segment !== "");
  for (const name of [segments[segments.length - 1], segments[segments.length - 2]]) {
    const palette = name === undefined ? undefined : HEAD_PALETTES[name.toLowerCase()];
    if (palette !== undefined) {
      return palette;
    }
  }
  return null;
};

export interface ProjectHeadProps {
  className: string;
  /** 只有套用品牌色時才有；是 CSS 自訂屬性，renderer 需要轉型成 CSSProperties。 */
  style?: Record<string, string>;
}

/** `.project-head` 該用的 className 與樣式變數：先看專案指定配色，再看 README 主色（字色白）；都沒有就維持原本的樣子。 */
export const projectHeadProps = (colors: BrandColorMap, path: string | null | undefined): ProjectHeadProps => {
  const readme = lookupBrandColor(colors, path);
  const palette = lookupHeadPalette(path) ?? (readme === null ? null : { background: readme, text: HEAD_TEXT_DEFAULT });
  return palette === null
    ? { className: "project-head" }
    : { className: "project-head branded", style: { "--brand": palette.background, "--brand-fg": palette.text } };
};
