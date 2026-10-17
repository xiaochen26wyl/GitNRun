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
| 專案啟動 | 以 `.gitnrun/run.json` 描述前端、後端、桌面服務，可指定 `fixedPort` 或動態配置 port，再於 iTerm2 分頁啟動；每個專案有 README 按鈕可直接開啟 README.md；依資料夾名稱分成「開源Free、SAAS、創作者宇宙、自己用、遊戲需要美術」5 個頁籤，不在分組表內的專案出現在「其他」頁籤 |

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

## 本機環境檔

GitNRun 本身目前不需要專案根目錄環境檔；GitHub、AI、通知等金鑰由 App 的本機加密保險庫管理。GitNRun 啟動的其他專案若有 dev／Debug 通關密碼，密碼必須留在該專案的 `.env`、`.env.local`、`.env.development`、`.env.development.local` 或 `.dev.vars`，GitNRun 只保存相對檔案路徑與鍵名，不保存密碼值。所有實際環境檔都必須由各專案的 `.gitignore` 排除。

## 架構

- `src/main`：主程序，負責 Node、網路、金鑰、監視器、規則引擎、AI、啟動器與資料存取。
- `src/preload`：透過 `contextBridge` 暴露受控 IPC API。
- `src/renderer`：React UI，不直接 import Electron、Node、main 或保險庫程式。
- `src/shared`：共用型別、IPC 通道與純函式。

分層邊界由 `scripts/check-boundary.ts` 檢查。詳細需求、規格、安全邊界與 AI 續作資訊請看 [`AI_SPEC.md`](AI_SPEC.md)。

## 品牌配色

本節列出 GitNRun 介面**全部**已定義的色票，供設計與 Logo 取色。單一來源是 [`src/renderer/styles.css`](src/renderer/styles.css) 的 `:root` token；介面固定為白底淺色，不跟隨系統深色模式，沒有深色變體。品牌主色由使用者確認，色碼一律取自該檔。

> **維護規則**：新增、修改或刪除色票時，必須同步更新本節；色碼與 [`src/renderer/styles.css`](src/renderer/styles.css) 不一致就是文件錯誤。

### 主要配色（Logo 取色）

| 角色 | 色碼 | 說明 |
|---|---|---|
| Accent 品牌綠 | `#15803D` | 品牌強調色（`--accent`）：選取中的頁籤、按鈕、注意事項 |
| Background 背景 | `#FFFFFF` | 頁面底色（`--bg`） |

### 完整色票

色碼全部取自上述 `:root`，用腳本產生；依用途分組。

#### 基底

| Token | 色碼 | 說明 |
|---|---|---|
| `--bg` | `#FFFFFF` | 頁面底色 |

#### 品牌強調

| Token | 色碼 | 說明 |
|---|---|---|
| `--accent` | `#15803D` | 品牌強調色：選取中的頁籤、按鈕、注意事項、分段按鈕選取態 |
| `--accent-text` | `#FFFFFF` | 強調色上的文字 |

#### 狀態色

| Token | 色碼 | 說明 |
|---|---|---|
| `--warn` | `#C2410C` | 警告與錯誤 |
| `--ok` | `#15803D` | 成功（與 `--accent` 同值，用途不同，分開定義） |

### 局部色／備註

以下是 [`src/renderer/styles.css`](src/renderer/styles.css) 裡直接寫死、沒有定義成 token 的顏色（依色碼與屬性合併，行號為撰寫當下該檔的行號），不屬於上面的正式色票：

| 色碼 | 屬性 | 行號 |
|---|---|---|
| `rgb(0 0 0 / 0.25)` | `box-shadow` | L163 |
| `rgba(0, 0, 0, 0.18)` | `box-shadow` | L603 |

- `--border`（L7）不是固定色碼：`color-mix(in srgb, currentColor 18%, transparent)`。
- `--soft`（L8）不是固定色碼：`color-mix(in srgb, currentColor 6%, transparent)`。
- 專案名稱列色條上的按鈕與徽章使用系統色 `CanvasText`（淺色模式下為黑），底色引用 `--bg`。

#### 專案名稱列指定配色

各專案名稱列（`.project-head`）的色條由 [`src/shared/brand.ts`](src/shared/brand.ts) 的 `HEAD_PALETTES` 指定；表裡沒有的專案，底色取該專案 README「品牌配色 → 主要配色」第一列色碼，文字固定白色（GitNRun 自己即屬此類，底色為上面的品牌綠）。

| 專案 | 底色 | 文字 | 來源 |
|---|---|---|---|
| toBloom | `#000000` | `#FFD93D` | toBloom README 的 Canvas 畫布、Ring Yellow 點綴黃 |
| fictionPurr、mahoPurr-Catalyst、translationService | `#FFFFFF` | `#000000` | 使用者指定白底黑字，不用粉色；外框 `#000000`（白色色條在白底頁面上靠細框看出邊界） |
| xiaochenStudio | `#0066CC` | `#FFFFFF` | fictionPurr README 的 Primary 主色 |
| Usage-Pulse | `#4C1D95` | `#FFFFFF` | 使用者指定深紫色，色碼為建議值 |
| yumeAegis | `#EA580C` | `#FFFFFF` | 使用者指定橘色，色碼為建議值 |

## 文件

- [`AI_SPEC.md`](AI_SPEC.md)：給 AI 與維護者使用的需求表、產品規格與技術規格。
- [`CONTRIBUTING.md`](CONTRIBUTING.md)：開發與貢獻流程。
- [`SECURITY.md`](SECURITY.md)：安全問題回報方式。
- [`LICENSE`](LICENSE)：Apache License 2.0。
