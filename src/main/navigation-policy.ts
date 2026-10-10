/**
 * 視窗允許載入／導航的網址判斷（純函式，不依賴 electron，方便測試）。
 * 渲染層只會載入自己打包的頁面，沒有任何正當理由導航到別處。
 */

export interface NavigationContext {
  /** dev server 的 origin（僅開發期有值）。 */
  devOrigin: string | null;
  /** 打包後渲染層目錄的 file:// 網址（結尾含斜線）。 */
  packagedPrefix: string;
}

export const originFromUrl = (url: string | undefined): string | null => {
  if (!url) {
    return null;
  }
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

export const isAllowedNavigationTarget = (target: string, context: NavigationContext): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return false;
  }

  if (context.devOrigin && parsed.origin === context.devOrigin) {
    return true;
  }

  // 打包後：只允許 dist/renderer 之下的檔案；用目錄網址做前綴比對，才能擋掉 `../`。
  return parsed.protocol === "file:" && parsed.href.startsWith(context.packagedPrefix);
};
