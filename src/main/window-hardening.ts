import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, session, type WebContents } from "electron";
import {
  isAllowedNavigationTarget,
  originFromUrl,
  type NavigationContext
} from "@main/navigation-policy";

/**
 * 整個行程範圍的 web contents 鎖定。
 *
 * 渲染層只載入自己打包的頁面、只透過 preload 橋接與主程序溝通，沒有理由開新視窗、
 * 導航到別處或掛 webview。明確禁止，才不會讓一個誤植的 target="_blank" 或任何
 * 意外變成標記的字串，長出一個帶有 gitNRun API 的活渲染程序。
 *
 * 在模組載入時註冊，而不是等 whenReady()，確保任何視窗建立前就已生效。
 */

export const navigationContext = (): NavigationContext => ({
  devOrigin: originFromUrl(process.env.ELECTRON_RENDERER_URL),
  packagedPrefix: pathToFileURL(join(app.getAppPath(), "dist/renderer/")).href
});

export const isTrustedUrl = (url: string): boolean => isAllowedNavigationTarget(url, navigationContext());

export const hardenWebContents = (contents: WebContents): void => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));

  contents.on("will-navigate", (event, url) => {
    if (!isTrustedUrl(url)) {
      event.preventDefault();
      console.warn("[gitnrun] blocked navigation attempt");
    }
  });

  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
};

export const installWebContentsHardening = (): void => {
  app.on("web-contents-created", (_event, contents) => hardenWebContents(contents));
};

/** 渲染層不需要任何瀏覽器權限（相機、定位、通知等），一律拒絕。 */
export const installSessionLockdown = (): void => {
  const target = session.defaultSession;
  target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);
};
