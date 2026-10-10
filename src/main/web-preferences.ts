import type { WebPreferences } from "electron";

/**
 * 全 app 唯一的 webPreferences 來源。所有視窗（含隱藏視窗）都必須經過這裡建立，
 * 不得在別處手寫 webPreferences，才能保證隔離旗標不會被漏設。
 */
export const buildSecureWebPreferences = (preload?: string): WebPreferences => ({
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  ...(preload ? { preload } : {})
});
