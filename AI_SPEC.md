# GitNRun AI 規格文件

本文件是給 AI agent 與維護者續作 GitNRun 時使用的主要需求表與規格來源。README 只保留精簡介紹；功能細節、產品邊界、安全要求與後續維護規則集中放在這裡。

## 專案目標與核心原則

- **本機優先**：使用者資料、設定、事件紀錄與金鑰都存在本機，不使用雲端資料庫，也不提供跨裝置同步。
- **開發工作流加速**：監視 GitHub 推送、整理事件、依規則自動通知或執行本機動作，並協助啟動專案常用服務。
- **安全預設保守**：遠端事件可觸發本機動作，因此寫入型動作預設需要使用者確認；未經授權不執行高風險指令。
- **AI 選擇加入**：任何會把內容送出電腦的 AI 功能都必須由專案層級允許，且要先過敏感資料遮蔽與排除規則。
- **分層清楚**：只有主程序可以接觸 Node、網路、金鑰與本機檔案；renderer 只能透過受控 IPC 使用功能。

## 功能需求表

| 功能 | 使用者價值 | 目前狀態 | 重要限制 |
|------|------------|----------|----------|
| 推送監視 | 即時知道 GitHub repo 有哪些推送 | 已支援輪詢；Webhook 為選配 | 輪詢模式推送者以 head commit 作者推定；Webhook 才能取得確切推送者 |
| 事件列表 | 快速查找推送、commit 與檔案變更 | 已支援篩選、搜尋與詳情 | 新推送不再自動跳桌面通知；要通知請用規則的「系統通知」動作 |
| 分支命名規則 | 讓開工分支與推送分支容易辨識 | 已支援範本與合規標示 | 預設範本為 `v{version}_{year}_{mmdd}` |
| 規則引擎 | 依事件自動通知、呼叫外部服務或執行本機動作 | 已支援條件與多種動作 | 寫入型動作預設需確認；匯入規則預設停用且需要確認 |
| AI 助手 | 產生 commit 訊息、事件摘要、推送建議與衝突說明 | 已支援 Claude/OpenAI 類型能力 | 每個專案預設不允許；無金鑰或離線時使用本機 fallback |
| 一鍵終端機 | 將常用資料夾與指令映射成快速啟動入口 | 已支援資料夾映射、快捷啟動與外部開啟 | iTerm2/Terminal 可自動執行指令；其他終端機通常只能開資料夾 |
| 專案啟動 | 一鍵啟動前端、後端、桌面與 Flutter web 服務，並用 README 按鈕開啟專案的 README.md | 已支援依資料夾名稱分成 5 個分組頁籤、個人專案根目錄掃描、`.gitnrun/run.json`、`package.json` scripts、Flutter 推測、固定或動態 port、停止、README 按鈕 | 僅支援 iTerm2 分頁啟動；推測出的服務需遵守注入的環境變數才會使用 GitNRun 配置的 port；README 只取專案根目錄的 `README.md`，一律用 Cursor 開啟，找不到時按鈕反灰；分組表寫在 `src/shared/run-groups.ts`，要改分組得改程式 |
| Dev 通關帳密 | 方便複製專案 dev/debug 登入資料 | 已支援專案層級帳號；Debug 密碼來源為專案環境檔裡的某個鍵（GitNRun 每次複製都重新讀取，只讀取、不保存、不寫入） | 帳號不進備份；環境檔路徑與鍵名隨設定備份，密碼留在專案環境檔，換機後隨專案回來 |
| Webhook 接收 | 更快取得推送事件與確切推送者 | 已支援本機接收端與簽章驗證 | 只綁 `127.0.0.1`；公開網址需使用者自備隧道 |
| 郵件通知 | 透過 email 推送事件或規則結果 | 動作類型保留 | 執行器尚未實作 |

## 技術規格

- 技術棧：Electron 43、electron-vite 3、React 18、TypeScript strict、pnpm 9、Node/Electron 內建 `node:sqlite`。
- 打包：`electron-builder`，目前支援 macOS DMG 與 Linux AppImage/deb；產物在 `release/`。
- `src/main` 是唯一能碰 Node、網路、金鑰、本機檔案與系統能力的層，包含監視器、規則引擎、執行器、AI、保險庫、啟動器、Webhook、通知與資料存取。
- `src/preload` 只透過 `contextBridge` 暴露 `src/shared/ipc.ts` 宣告的 API，不放任意 Node 能力到 renderer。
- `src/renderer` 是 React UI，不能 import Electron、Node、main、vault 或任何只屬於主程序的模組。
- `src/shared` 放共用型別、IPC 通道、驗證、格式化、範本、glob 等純函式。
- IPC 入參必須先 fail-closed 驗證；發送端必須是本 App 自己的頁面。
- 視窗一律使用 `contextIsolation` 與 `sandbox`；CSP 禁止 renderer 直接對外連線，所有網路請求都在主程序發生。
- 層級邊界由 `scripts/check-boundary.ts` 強制檢查。

## 安全與隱私規格

- 資料目錄：`~/Library/Application Support/GitNRun/`。
- 主要資料庫：`data/gitnrun.db`，資料夾權限應為 0700，資料庫權限應為 0600。
- 設定備份：`data/backups/`，每天本地時間 22:00 自動備份一次（錯過則下次啟動補做），也可手動「立即備份」；保留最近 10 份；備份不包含金鑰與 dev 通關帳密。
- 金鑰包含 GitHub token、Anthropic/OpenAI key、Slack Webhook URL、Webhook 簽章 secret、規則敏感環境變數與 dev 密碼。
- 金鑰由 Electron `safeStorage` 加密，密文存在 SQLite；系統無法加密時一律拒絕儲存，不退回明文。
- UI 只顯示「已設定」與末四碼；存入後不提供讀回明文。
- 明文只在主程序使用當下短暫解密，用完即丟；不得放入 argv、日誌或備份。
- 日誌、指令輸出與 AI 請求記錄寫入前必須遮蔽已知密鑰值與常見 token 格式。
- GitHub token 建議使用 fine-grained token，僅給 Contents: Read 與 Metadata: Read。
- 規則的 shell 動作不得把事件內容拼進命令字串；事件資料以環境變數傳入。
- 子行程只拿白名單環境，不繼承 App 的完整環境變數。

## AI 規格

- 每個專案預設不允許 AI 分析；必須由使用者在專案設定中開啟。
- commit 訊息功能會送出程式碼差異，但 `.env*`、金鑰檔、lock 檔等排除清單內容不得送出。
- 送出前要遮蔽疑似密鑰字串，並提供預覽會送出內容的能力。
- 事件摘要與推送建議只送 commit 訊息與檔名。
- 衝突預測由本機 `git merge-tree` 判斷；AI 只取得檔名與 git 說明。
- 沒有金鑰、專案未允許、額度用完或離線時，功能要自動改用本機規則並說明原因。
- AI 請求需有頻率限制、每日上限、相同輸入本機快取，以及短時間多筆事件合併機制。

## 啟動描述檔與專案啟動規格

專案啟動頁會列出已設定本機路徑的專案（每個專案名稱旁有「README」按鈕，開啟專案根目錄的 `README.md`；原本的「文件空間」分頁已併入這裡，「專案根目錄」設定移到設定頁，供 Git / GitHub 頁掃描 repo），並自動掃描 `/Users/zorawl/Documents/GitHub` 第一層資料夾；已存在於專案資料表的項目以資料表名稱為準，其餘使用資料夾名稱。每個專案不需要手動新增設定檔；GitNRun 會先讀取可選的 `.gitnrun/run.json`，沒有描述檔時再從 `package.json` scripts 推測服務，仍找不到時再依 Flutter 專案結構推測 Flutter web、iOS 模擬器與 Android 模擬器的啟動方式。

專案啟動拆成 5 個頂部分組頁籤：開源Free（Usage-Pulse）、SAAS（stockPaw、toBloom、xiaochenStudio）、創作者宇宙（fictionPurr、translationService、MahoPurr-Catalyst）、自己用（GitNRun、socialHub）、不知道什麼時候才完成（yumeAegis）。每個頁籤只列屬於該組的專案；歸類只看專案資料夾路徑最後一段名稱，不分大小寫，不看資料表裡的顯示名稱。對不到任何一組的專案會讓「其他」頁籤出現在分組頁籤之後，沒有這類專案時不顯示。頁籤內的專案依分組表的資料夾順序排列，不受資料表或資料夾掃描順序影響；fictionPurr 卡片內的服務列另依開發優先順序排列（api、desktop-mahopurr、mobile-mahopurr、web-sparkpurr、mobile-fictionpurr、web-fictionpurr、mobile-anipurr、mobile-poppurr，同層級相鄰，未列到的服務接在最後），只影響畫面順序，不影響啟動順序。分組表、服務列順序表與比對規則都在 `src/shared/run-groups.ts`。

`.gitnrun/run.json` 是進階覆寫設定，可進版控，用來明確描述服務啟動方式。

```json
{
  "version": 1,
  "services": [
    {
      "name": "api",
      "role": "backend",
      "cwd": "apps/api",
      "command": ["make", "run"],
      "port": true,
      "fixedPort": 5174,
      "env": { "PORT": "{port}", "FRONTEND_URL": "{web.url}" }
    },
    {
      "name": "web",
      "role": "frontend",
      "command": ["pnpm", "dev"],
      "port": true,
      "env": { "PORT": "{port}", "API_BASE": "{api.url}" }
    },
    {
      "name": "panel",
      "role": "desktop",
      "command": ["pnpm", "dev:desktop"],
      "port": true,
      "needs": ["api"],
      "env": { "PORT": "{port}", "API_BASE": "{api.url}" }
    }
  ]
}
```

- `role` 支援 `backend`、`frontend`、`desktop`。
- 後端與前端服務必須 `port: true`。
- 可選 `fixedPort: 1024～65535`；只能用於 `port: true`，同一描述檔不可重複。未指定者維持動態配置；固定 port 已被占用時拒絕啟動，不改用其他號碼，也不結束占用它的程序。
- 沒有描述檔時，`package.json` 會依 script 名稱推測 backend、frontend、desktop；推測出的 web/backend 服務會注入 `PORT`、`DEV_PORT`，有後端時 frontend 也會注入 `API_BASE_URL`、`VITE_API_BASE_URL`。
- Flutter 專案（只有 `pubspec.yaml`、沒有描述檔）可推測出三個服務：`flutter`（`flutter run -d chrome --web-port {port}`）、`flutter-ios`（先啟動並等待固定的 `498D038D-9A95-4CB5-967C-B846B0E93DE8`，再執行 Flutter）、`flutter-android`（先啟動固定的 `Pixel_6_API_34_dev` AVD，解析其 ADB serial，再執行 `flutter run -d <serial>`）。iOS 固定使用選定的 `iPhone 17 dev` UUID；Android 不再使用泛用的 `emulator` target。iOS 與 Android 模擬器是各自獨立的 desktop 服務，由使用者個別啟動，不會一起被帶起來；熱更新由 `flutter run` 所在的終端機自己處理，GitNRun 不提供熱更新按鈕。專案啟動頁把每個專案的 iOS、Android 服務合併成一列「mobile」，按鈕為「啟動 iOS」「啟動 Android」，重新啟動與結束只在該平台已啟動時才出現。
- 「啟動前後端」啟動所有 backend 與 frontend 服務。
- 「重新啟動」先結束舊服務（結束 port 上的程序、關閉舊的終端機分頁，手機服務連同該平台的模擬器一起關），並等舊程序釋放 port，再用同一組 port 重新開啟；任一步結束失敗或 port 仍被占用就不開新分頁。
- 「停止」依目前記錄的 port 停止服務，成功後清掉該專案的執行狀態與 `.dev/ports.json` 內容。
- 「開網頁」只在 frontend 已執行時開啟實際 `http://localhost:<port>`，不自動啟動服務。
- 「開桌面」啟動 desktop 服務與它 `needs` 的服務。
- 「指令」按鈕點擊即把該服務顯示用的指令複製到剪貼簿（手機列為「iOS 指令」「Android 指令」各一顆），並展開指令浮層。
- 專案名稱列（各分頁共用）文字 20px；色條底色與字色依 `src/shared/brand.ts` 的專案指定配色表，表裡沒有的專案取 README「主要配色」第一列色碼、文字白色；色碼清單見 README「品牌配色」。
- 介面固定為白底綠色配色（不跟隨系統深色模式）：選取中的頁籤、按鈕、注意事項使用品牌綠；全視窗最小字級 14px，專案分組頁的 app 名稱 16px。
- `command` 是程式與參數陣列，每一項單獨引用後送進 iTerm2，不經 shell 解析。
- `cwd` 必須是專案內相對路徑，且不能透過符號連結跳出專案。
- 支援佔位：`{port}`、`{url}`、`{服務名.port}`、`{服務名.url}`。
- 打錯佔位、指向不存在或沒有 port 的服務、`needs` 循環依賴都必須拒絕。
- 描述檔是不可信輸入；不得設定 `PATH`、`HOME`、`NODE_OPTIONS`、`DYLD_*`、`LD_*` 等會改變行程載入行為的環境變數。
- 字串長度、服務數量、環境變數數量與輸出記錄都需要有上限。
- 第一次執行，以及內容變更後第一次執行，必須跳出原生對話框列出所有指令；預設按鈕是「拒絕」。
- 確認過的內容雜湊只存在本機，不進備份；還原備份後需重新確認。
- 動態 port 在按下啟動按鈕當下向作業系統取得，避開固定 port 與留給手動啟動的 5173、5174（`src/shared/reserved-ports.ts`），且同一批不得重複；GitNRun 自己的 dev server 也撇除這兩個號碼；固定 port 依描述檔配置。重新啟動時沿用原設定，停止後清除執行記錄。
- 實際網址顯示在專案列，也寫入該專案 `.dev/ports.json` 作為當次提示；它不是穩定設定檔，使用前仍要確認服務存活。
- 停止功能以目前記錄的 port 查找並終止監聽行程；若服務沒有可偵測 port，可能需要使用者在 iTerm2 分頁中手動停止。

## Webhook 規格

- 預設輪詢不需要任何設定。
- Webhook 接收端只綁 `127.0.0.1`；公開入口由使用者自備隧道，例如 ngrok。
- 每個 Webhook 請求必須通過 `X-Hub-Signature-256` 驗證；簽章錯誤或缺少一律 403。
- 使用 `X-GitHub-Delivery` 去重。
- GitHub payload 最多帶 20 個 commit；大量推送時檔案清單是不完整下限。

## 開發與驗證

常用指令：

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm check:boundary
pnpm test:unit
pnpm build && pnpm smoke:build
pnpm dist:mac
pnpm dist:linux
```

文件變更通常不需要跑 build 或 unit test；若文件描述的功能行為被同步修改，需依影響範圍補跑對應檢查。

## 維護規則

- 每完成一個功能，結案時必須詢問使用者：「要不要同步更新 `AI_SPEC.md`？」
- 若該功能影響使用者可見能力、安裝方式、開發方式或主要功能列表，也要同步建議是否更新 `README.md`。
- `AI_SPEC.md` 應保持可被 AI 直接讀懂：寫清楚需求、行為邊界、安全限制、資料流與驗證方式。
- README 應保持精簡，只作為專案入口與文件導覽，不累積完整規格。
- `CLAUDE.md` 是本機 Claude Code 專用規則，不作為通用 AI 規格來源；除非使用者明確要求，維護本文件時不要修改 `CLAUDE.md`。
