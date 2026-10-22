/** 專案啟動頁服務標題的滑鼠提示：先依「專案資料夾 + 服務名稱」精準對應，對不到再用名稱前綴的通用說明（純函式，不依賴 DOM／Node）。 */

import { folderNameOf } from "@shared/run-groups";

const BACKEND_HINT = "提供資料與業務邏輯";
const EDGE_HINT = "邊緣節點，負責轉發與快取";

/** key 是「專案資料夾名稱（小寫）/服務名稱（小寫）」。 */
const EXACT_HINTS: ReadonlyMap<string, string> = new Map([
  ["stockpaw/api", BACKEND_HINT],
  ["stockpaw/edge", EDGE_HINT],
  ["tobloom/api", `Cloudflare Worker 後端，${BACKEND_HINT}`],
  ["fictionpurr/api", `Django 後端，${BACKEND_HINT}`],
  ["translationservice/api", "翻譯服務後端（FastAPI）"],
  ["translationservice/panel", "翻譯服務的桌面管理面板，需先啟動 api"],
  ["mahopurr-catalyst/catalyst", "Python 後端服務"]
]);

const PREFIX_HINTS: ReadonlyArray<readonly [prefix: string, hint: string]> = [
  ["web", "網頁前端"],
  ["mobile", "手機 App"],
  ["desktop", "桌面 App"],
  ["api", BACKEND_HINT]
];

export const serviceHintOf = (folder: string, serviceName: string): string | undefined => {
  const name = serviceName.toLowerCase();
  const exact = EXACT_HINTS.get(`${folderNameOf(folder).toLowerCase()}/${name}`);
  if (exact !== undefined) return exact;
  return PREFIX_HINTS.find(([prefix]) => name === prefix || name.startsWith(`${prefix}-`))?.[1];
};
