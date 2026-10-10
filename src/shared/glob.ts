/**
 * 簡單萬用符號比對（純函式，主程序與渲染層共用）。
 *
 * - `*`：任意字元；在 pathAware 模式下不跨越 `/`
 * - `**`：任意字元（含 `/`）
 * - `?`：單一字元；在 pathAware 模式下不為 `/`
 *
 * 長度有上限，且連續的 `*` 會被合併，避免惡意或失控的樣式造成過度回溯。
 */

export const MAX_GLOB_LENGTH = 200;

export interface GlobOptions {
  /** true：`*` 與 `?` 不跨越 `/`（檔案路徑）；false：`*` 可跨越（分支名稱）。 */
  pathAware?: boolean;
}

const escapeRegExp = (text: string): string => text.replace(/[.+^${}()|[\]\\]/g, "\\$&");

export const globToRegExp = (pattern: string, options: GlobOptions = {}): RegExp | null => {
  if (pattern.length === 0 || pattern.length > MAX_GLOB_LENGTH) {
    return null;
  }
  const pathAware = options.pathAware ?? false;
  const star = pathAware ? "[^/]*" : ".*";
  const single = pathAware ? "[^/]" : ".";

  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i] as string;
    if (char === "*") {
      let run = 1;
      while (pattern[i + 1] === "*") {
        run += 1;
        i += 1;
      }
      source += run >= 2 ? ".*" : star;
    } else if (char === "?") {
      source += single;
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`);
};

export const matchGlob = (pattern: string, text: string, options: GlobOptions = {}): boolean => {
  const regExp = globToRegExp(pattern, options);
  return regExp !== null && regExp.test(text);
};

/** 任一樣式符合即為真；空清單視為「不限制」。 */
export const matchesAnyGlob = (patterns: readonly string[], text: string, options: GlobOptions = {}): boolean =>
  patterns.length === 0 || patterns.some((pattern) => matchGlob(pattern, text, options));
