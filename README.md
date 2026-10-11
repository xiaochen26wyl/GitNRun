# GitNRun

GitNRun 是本機優先的 GitHub 推送監視與開發啟動工具。所有資料都存在你的電腦上，不使用雲端資料庫；可監視 repo 推送、依規則自動通知或執行動作、輔助產生 AI commit 內容，並一鍵啟動專案常用服務。

支援 macOS 與 Linux；部分終端機自動化功能目前以 macOS 為主。

## 主要功能

| 功能 | 說明 |
|------|------|
| 推送監視 | 以 GitHub 輪詢或選配 Webhook 偵測 repo 推送 |
| 事件列表 | 依專案、分支、時間篩選事件，查看 commit 與檔案詳情 |
| 分支命名規則 | 用範本建立開工分支，並標示不合規的推送分支 |
| 規則引擎 | 依分支、檔案、推送者、時間等條件觸發通知、Webhook、git、自訂 shell 或 AI 動作 |
| AI 助手 | 產生 commit 訊息、事件摘要、推送建議與衝突說明；每個專案預設需手動允許 |
| 一鍵終端機 | 將資料夾映射到常用指令，快速在終端機開啟並執行 |
| 專案啟動 | 以 `.gitnrun/run.json` 描述前端、後端、桌面服務，一鍵配置 port 並在 iTerm2 分頁啟動 |
| 文件空間 | 自動整理已加入專案的 README，也可保存常用檔案與資料夾捷徑 |

## 安裝

目前請從原始碼建置。需要 Node 24 與 pnpm 9。

```bash
pnpm install
pnpm dist:mac   # 產物在 release/，arm64 與 x64 各一份 DMG
pnpm dist:linux # 產物在 release/，x64 AppImage 與 deb
```

打包出的 App 未簽章也未公證。macOS 第一次開啟時若被 Gatekeeper 擋下，請到「系統設定 -> 隱私權與安全性」選擇仍要打開。

## 開發

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm check:boundary
pnpm test:unit
pnpm build && pnpm smoke:build
```

SQLite 使用 Node/Electron 內建的 `node:sqlite`，不需要額外編譯原生模組。

## 架構

- `src/main`：主程序，負責 Node、網路、金鑰、監視器、規則引擎、AI、啟動器與資料存取。
- `src/preload`：透過 `contextBridge` 暴露受控 IPC API。
- `src/renderer`：React UI，不直接 import Electron、Node、main 或保險庫程式。
- `src/shared`：共用型別、IPC 通道與純函式。

分層邊界由 `scripts/check-boundary.ts` 檢查。詳細需求、規格、安全邊界與 AI 續作資訊請看 [`AI_SPEC.md`](AI_SPEC.md)。

## 文件

- [`AI_SPEC.md`](AI_SPEC.md)：給 AI 與維護者使用的需求表、產品規格與技術規格。
- [`CONTRIBUTING.md`](CONTRIBUTING.md)：開發與貢獻流程。
- [`SECURITY.md`](SECURITY.md)：安全問題回報方式。
- [`LICENSE`](LICENSE)：Apache License 2.0。
