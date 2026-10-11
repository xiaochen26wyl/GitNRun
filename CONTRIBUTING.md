# 貢獻指南

感謝你有興趣參與 GitNRun。這份文件說明怎麼把開發環境跑起來、程式碼怎麼分層，以及送出 PR 前要通過哪些檢查。

安全問題請**不要**開公開 issue，改依 [`SECURITY.md`](SECURITY.md) 私下回報。

## 開發環境

- macOS 或 Linux（CI 目前在 `macos-latest` 上跑）
- Node 24
- pnpm 9（版本由 `package.json` 的 `packageManager` 欄位指定）

```bash
pnpm install
pnpm dev
```

SQLite 使用 Node／Electron 內建的 `node:sqlite`，不需要編譯原生模組。

## 專案結構與層級邊界

| 目錄 | 角色 |
|------|------|
| `src/main` | 主程序。**唯一**能碰 Node、網路與金鑰的層：監視器、規則引擎、執行器、AI、密鑰保險庫、啟動器、Webhook |
| `src/preload` | `contextBridge` 橋接，只暴露 `src/shared/ipc.ts` 宣告的方法 |
| `src/renderer` | React UI。不能 import Electron、Node 內建模組、主程序模組或保險庫 |
| `src/shared` | 型別、IPC 通道與純函式（驗證、範本、glob…），主程序與渲染層共用，不能有副作用 |
| `tests/` | `node:test` 單元測試，檔名 `*.test.ts` |

這些邊界由 `pnpm check:boundary` 強制（規則在 `scripts/boundary.ts`）：

- `renderer`／`shared`：不得 import `electron`、Node 內建模組、`@main` 或任何 vault 模組。
- `preload`：只允許 import `electron`，其餘同上。

新增功能時請依這個原則放置程式碼：需要檔案系統、網路、子行程、金鑰的邏輯放在 `src/main`，畫面放在 `src/renderer`，兩邊都用得到的型別與純函式放在 `src/shared`。渲染層的 CSP 禁止任何對外連線，所有網路請求只能在主程序發生。

## 送出 PR 前

請在本機確認下列指令全部通過（與 CI 相同）：

```bash
pnpm typecheck
pnpm check:boundary
pnpm test:unit
pnpm build
pnpm smoke:build
```

- 行為變更請附對應的測試；修 bug 請附能重現該 bug 的測試案例。
- 只改任務需要的範圍，不順便重排無關程式或修與當前任務無關的 warning。
- 動到 UI 時，請檢查其他頁面是否因此跑版，不只看你改的那一頁。
- IPC 入參一律要過 fail-closed 驗證；新增通道時，在 `src/shared/ipc.ts` 宣告，並在主程序端補上驗證（`src/main/ipc-validation.ts`）。

## 密鑰與資料

- **不得**在 PR 中提交任何真實的 token、金鑰、Webhook URL 或個人路徑。測試請使用明顯的假值。
- 密鑰只存在使用者本機的加密保險庫，不能寫進日誌、備份、指令參數或畫面。新增日誌或輸出前，請確認會經過既有的脫敏處理（`src/main/log-redaction.ts`）。
- 不要新增遙測、自動回傳或任何會讓使用者資料離開本機的行為；AI 呼叫維持「每個專案各自選擇加入」。

## Commit 訊息

建議使用 Conventional Commits：`<type>: <簡短說明>`，type 為 `feat`、`fix`、`chore`、`docs`、`refactor`、`style`、`test`。說明可用繁體中文或英文。

## 授權

送出貢獻即表示你同意以 [Apache License 2.0](LICENSE) 授權你的貢獻。
