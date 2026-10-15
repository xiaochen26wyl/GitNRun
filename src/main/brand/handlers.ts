import { join, sep } from "node:path";
import { isBrandColor, parseBrandColor, type BrandColorMap } from "@shared/brand";
import { normalizeFolderPath } from "@shared/launcher";

/** 讀各專案根目錄 README 的品牌主色；檔案系統由外部注入，方便測試。 */

/** README 超過這個大小就不讀，避免被巨大檔案拖慢。 */
export const BRAND_README_MAX_BYTES = 256 * 1024;

const README_NAME = /^readme\.md$/i;

export interface BrandFs {
  /** 資料夾裡的檔名；不是資料夾或讀不到回傳 null。 */
  readDir(path: string): Promise<string[] | null>;
  /** 不存在回傳 null。 */
  lstat(path: string): Promise<{ size: number; isFile: boolean; isSymbolicLink: boolean } | null>;
  /** 不存在回傳 null。 */
  realpath(path: string): Promise<string | null>;
  readFile(path: string): Promise<string>;
}

const isInside = (root: string, candidate: string): boolean => candidate === root || candidate.startsWith(root + sep);

/** 只取專案根目錄的 README.md（大小寫不拘）；符號連結只在指向專案資料夾內的一般檔案時才讀。 */
const readReadme = async (folder: string, fs: BrandFs): Promise<string | null> => {
  const names = await fs.readDir(folder);
  const name = names?.find((entry) => README_NAME.test(entry));
  if (name === undefined) {
    return null;
  }
  let path = join(folder, name);
  let info = await fs.lstat(path);
  if (info === null) {
    return null;
  }
  if (info.isSymbolicLink) {
    const root = await fs.realpath(folder);
    const target = await fs.realpath(path);
    if (root === null || target === null || !isInside(root, target)) {
      return null;
    }
    path = target;
    info = await fs.lstat(path);
    if (info === null) {
      return null;
    }
  }
  if (!info.isFile || info.size > BRAND_README_MAX_BYTES) {
    return null;
  }
  return fs.readFile(path);
};

/** 單一資料夾的品牌色；任何失敗（沒有 README、讀不到、解析不出色碼）都回 null。 */
export const readBrandColor = async (folder: string, fs: BrandFs): Promise<string | null> => {
  try {
    const text = await readReadme(folder, fs);
    const color = text === null ? null : parseBrandColor(text);
    return isBrandColor(color) ? color : null;
  } catch {
    return null;
  }
};

/** 資料夾（正規化）→ 品牌色；沒有品牌色的資料夾不會出現。 */
export const readBrandColors = async (folders: readonly string[], fs: BrandFs): Promise<BrandColorMap> => {
  const unique = [...new Set(folders.map(normalizeFolderPath))];
  const found = await Promise.all(unique.map(async (folder) => [folder, await readBrandColor(folder, fs)] as const));
  const colors: Record<string, string> = {};
  for (const [folder, color] of found) {
    if (color !== null) {
      colors[folder] = color;
    }
  }
  return colors;
};

export interface BrandHandlers {
  colors(): Promise<BrandColorMap>;
}

export const createBrandHandlers = (deps: { listFolders: () => readonly string[]; fs: BrandFs }): BrandHandlers => ({
  colors: () => readBrandColors(deps.listFolders(), deps.fs)
});
