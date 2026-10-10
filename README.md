# GitNRun

本機 GitHub 推送監視器：**所有資料都存在你的電腦上，不使用任何雲端資料庫**。監視 repo 的推送、依規則自動做事、
AI 輔助 commit 訊息、一鍵在指定資料夾開啟終端機並執行指令。僅支援 macOS。

## 功能

| 功能 | 說明 |
|------|------|
| 推送監視 | 預設以條件式輪詢（ETag，304 不消耗 rate limit）偵測推送，約 15～30 秒內發現；選配 Webhook 可到 1 秒內並取得確切推送者 |
| 事件列表 | 專案／分支／時間篩選、搜尋、commit 與檔案詳情、桌面通知（可依專案靜音） |
| 分支命名規則 | 可自訂的範本（預設 `v{version}_{year}_{mmdd}`），用來「開工」建立新分支，也用來標示不合規的推送分支 |
| 規則引擎 | 條件（分支、檔案、推送者、時間、檔案數…）→ 動作（通知、Slack、Webhook、git、自訂 shell、AI…） |
| AI 助手 | Claude／OpenAI 產生 commit 訊息、事件摘要、推送建議、衝突說明；每個專案要各自允許 |
| 一鍵終端機 | 資料夾 → 指令映射、Terminal／iTerm2、全域快捷鍵、托盤選單、拖曳資料夾 |
| 專案啟動 | 「專案啟動」分頁平面列出所有專案，每列直接有「一鍵前後端」「開網頁」「開桌面視窗」三顆按鈕；服務在 iTerm2 分頁執行，port 在按下當下配置（不固定、不使用 AI） |

## 安裝

目前請從原始碼建置（需要 Node 24 與 pnpm 9）：

```bash
pnpm install
pnpm dist:mac   # 產物在 release/，arm64 與 x64 各一份 DMG
```

打包出的 DMG **未簽章也未公證**，第一次開啟時 macOS 的 Gatekeeper 會擋下。到「系統設定 → 隱私權與安全性」，在被擋下的 App 旁選擇「仍要打開」即可。若你不信任某個來源散布的 DMG，請自行從原始碼建置。

## 開發

```bash
pnpm install
pnpm dev              # 由你自行啟動
pnpm typecheck        # 兩份 tsconfig
pnpm check:boundary   # 渲染層／preload 的邊界守衛
pnpm test:unit        # node:test（tsx）
pnpm build && pnpm smoke:build
pnpm dist:mac         # DMG（arm64 + x64，未簽章）
```

需要 Node 24 與 pnpm 9。SQLite 使用 Node／Electron 內建的 `node:sqlite`，不需要編譯原生模組。

## 架構

- `src/main`：主程序。唯一能碰 Node、網路、金鑰的層。服務模組：監視器、規則引擎、執行器、AI、保險庫、啟動器、Webhook。
- `src/preload`：`contextBridge` 橋接，只暴露 `src/shared/ipc.ts` 宣告的方法。
- `src/renderer`：React UI。不能 import Electron／Node／main／保險庫（由 `scripts/check-boundary.ts` 在 CI 強制）。
- `src/shared`：型別、IPC 通道、純函式（驗證、範本、glob…），兩邊共用。

所有 IPC 入參先過 fail-closed 驗證，發送端必須是本 App 自己的頁面。視窗一律 `contextIsolation`、`sandbox`，
CSP 禁止渲染層任何對外連線——所有網路請求只在主程序發生。

## 資料與金鑰

- 資料夾：`~/Library/Application Support/GitNRun/`
  - `data/gitnrun.db`：SQLite（權限 0600，資料夾 0700）
  - `data/backups/`：設定備份 JSON（保留最近 10 份）
- **金鑰**（GitHub token、Anthropic／OpenAI 金鑰、Slack Webhook URL、Webhook 簽章 secret、規則的敏感環境變數）：
  - 由 Electron `safeStorage` 加密（加密金鑰在 macOS Keychain，項目名稱 *GitNRun Safe Storage*），密文存在 SQLite 的 `api_keys` 表。
  - **系統無法加密時一律拒絕儲存，不會退回明文。**
  - 畫面永遠只看得到「已設定、末四碼」，看不到明文，也看不到密文；存下去就讀不回來。
  - 明文只在使用的當下於主程序短暫解密，用完即丟；不放在 argv、不寫進日誌、不放進備份。
  - 日誌、指令輸出、AI 請求記錄寫入前一律脫敏（token 格式＋已知密鑰值的精確比對）。
- **換機或重裝**：密文只有同一台機器、同一個登入帳號、同一個 App 身分解得開，備份也不含金鑰。還原設定後要重新輸入所有金鑰。
- 未簽章的版本更新後，macOS 可能再次要求 Keychain 授權；解不開時畫面會標示「已存但無法解密，請重新輸入」。
- GitHub token 建議用 **fine-grained token，只給 Contents: Read 與 Metadata: Read**。監視只需要讀取；本機的 push 用的是你自己的 git 憑證。

## 專案啟動

「專案啟動」分頁把每個專案列成一列（不用下拉），列上直接有三顆按鈕：

- **一鍵前後端**：把後端與前端各開成 **iTerm2** 的一個分頁（同一個新視窗），不開瀏覽器、不開桌面視窗。
- **開網頁**：前端已在執行時，用系統預設瀏覽器開啟它實際的 `http://localhost:<port>`；沒在跑不會自動啟動。
- **開桌面視窗**：啟動 Electron 桌面版（以及它依賴的後端），視窗只有按這顆才會出現。

不適用的按鈕維持顯示但反灰，旁邊寫原因（沒有桌面版、前端尚未啟動、找不到 iTerm2…）。專案來源：已設定本機路徑的專案，加上拖曳加入的資料夾。

**port 不固定**：按下按鈕當下由 GitNRun 向作業系統要空 port（同一批不重複），以環境變數或參數傳給各服務，並把「前端指向後端」這類網址接好。已經在執行的服務沿用原 port。實際網址顯示在該列，也寫入專案的 `.dev/ports.json`（只是提示，使用前要先確認服務還活著；請把 `.dev/` 加進該專案的 `.gitignore`）。

服務跑在 iTerm2 裡，GitNRun 不監管行程，所以**沒有停止按鈕**：關掉該分頁或按 Ctrl+C 即停止，狀態（執行中／啟動中／未啟動）以 TCP 連線探測得出，會自動回到未啟動。整個功能是確定性邏輯，**不呼叫任何 AI 服務**。

**Dev 通關帳號／密碼**：每個專案列下方有一格，存這個專案 dev 專用的 debug 登入帳號與密碼，方便貼到網頁或模擬器。兩個都可以留空，GitNRun 不會把它們寫進專案檔案或帶進啟動指令。
- 密碼和其他金鑰一樣由系統金鑰保護加密；畫面只顯示「已設定、末四碼」，輸入新值即可取代，「清除密碼」可移除。「複製密碼」由主程序寫入剪貼簿，60 秒後自動清除（剪貼簿裡已被換成別的內容就不動它）。
- 帳號不是密鑰，直接顯示、直接編輯，「複製帳號」一般複製。
- 帳號與密碼都不進設定備份；換機或還原備份後需重新輸入。移除自己加入的資料夾時一併刪除。

### 啟動描述檔 `.gitnrun/run.json`

每個專案在自己的資料夾放一份描述檔（隨專案進版控）：

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

- `role`：`backend`、`frontend`、`desktop`。後端與前端必須 `port: true`；「一鍵前後端」啟動所有後端與前端，「開桌面視窗」啟動 `desktop` 服務與它 `needs` 的服務。
- `command` 是「程式＋參數」的陣列，每一項都會被單獨引用再送進 iTerm2，不經過 shell 解析；`cwd` 是專案內的相對路徑。
- 佔位：`{port}`、`{url}`（自己的），`{服務名.port}`、`{服務名.url}`（其他服務的）。打錯的佔位、指向不存在或沒有 port 的服務、`needs` 循環依賴都會被拒絕。
- 描述檔來自專案資料夾，會隨 `git pull` 改變，所以一律當不可信輸入：不能設定 `PATH`、`HOME`、`NODE_OPTIONS`、`DYLD_*`、`LD_*` 等會改變行程載入行為的環境變數，工作目錄不能跳出專案（含符號連結），字串長度與數量有上限。
- **第一次執行、以及內容變更後第一次執行**，會先跳出原生對話框列出所有指令，預設按鈕是「拒絕」；確認過的內容雜湊只存在這台機器（不進備份、還原備份後需重新確認）。
- GitNRun 自己不提供啟動項目（它有單一實例鎖，再開一個實例會直接結束）。

## 規則與安全

規則會由遠端的推送事件觸發本機動作，所以預設保守：

- **寫入型動作**（git、自訂 shell、外送 Webhook、開工）預設先跳出系統對話框，顯示完整指令、工作目錄、環境變數名稱，等你按「允許」；逾時視為跳過並記錄。唯讀動作（通知、摘要）自動執行。規則可個別開啟「免確認」。
- 事件內容（分支名、commit 訊息、推送者）**只會當資料**：shell 動作用 `PW_BRANCH`、`PW_MESSAGE` 等環境變數取得，從不拼進指令字串；git 動作的 `{branch}` 先驗證是合法分支名稱才代入。
- 指令只在該事件所屬專案「已登錄的本機路徑」執行；子行程只拿到白名單環境，不繼承 App 的環境變數。
- 規則自己的 push 會被記錄，不會再觸發同一條規則；另有冷卻時間與每小時 30 次的硬上限。
- 匯入的規則一律是**停用**且**需要確認**的狀態，需要檢查後自行啟用。

## AI 與隱私

AI 呼叫本質上會讓內容離開你的電腦，所以是**選擇加入**：

- 每個專案預設不允許；在「專案」分頁勾選「允許 AI 分析」才會送出。
- commit 訊息會送程式碼差異：`.env*`、金鑰檔、lock 檔等排除清單上的檔案**內容完全不送**，其餘內容中疑似密鑰的字串會遮蔽；產生前可先「預覽會送出什麼」。
- 事件摘要與推送建議只送 commit 訊息與檔名；衝突預測由本機 `git merge-tree` 判斷，AI 只拿到檔名與 git 的說明。
- 沒有金鑰、專案沒開、額度用完或離線時，自動改用本機規則並說明原因。有頻率與每日上限、相同輸入的本機快取、短時間內多筆事件合併成一次請求。

## Webhook（選配）

預設的輪詢不需要任何設定。要用 Webhook：

1. 設定 → Webhook：啟用本機接收端（只綁 `127.0.0.1`），自備隧道（例如 `ngrok http 8765`），把 https 網址填進去。
2. 專案 → 把專案的監視模式切到「Webhook」或「輪詢＋Webhook」。
3. 設定 → Webhook → 該專案「產生 secret」（直接複製到剪貼簿，60 秒後自動清除，不會顯示在畫面上）。
4. GitHub repo → Settings → Webhooks → Add：Payload URL 貼畫面上的網址，Content type 選 `application/json`，Secret 貼上，Events 選 *Just the push event*。

每個請求都必須通過 `X-Hub-Signature-256` 驗證（簽章錯誤或缺少一律 403），並以 `X-GitHub-Delivery` 去重。
免費版 ngrok 每次重啟網址會變，要重新貼到 GitHub。

## 已知限制

- **推送者**：輪詢模式是以 head commit 的作者推定（畫面標示「推定」）；Webhook 模式才有確切的推送者，且會取代先到的推定值。
- **Webhook 的檔案清單**：GitHub 的 payload 最多帶 20 個 commit，推很多 commit 時檔案清單是不完整的下限。
- **郵件通知**：動作類型已保留，但寄信的執行器尚未實作（需要新增寄信套件），目前執行會回報「尚未支援」。
- **Finder 右鍵快速動作**：已支援 `gitnrun://launch?path=<資料夾>` 協定（只啟動已有映射的資料夾，未映射的會先問你），但沒有提供自動安裝 Quick Action；可在 Automator 自行建立「執行 Shell 指令碼」呼叫 `open`。
- **其他終端機**（Warp 等）只能在資料夾開啟，不能自動執行指令；Terminal 與 iTerm2 可以。首次使用需允許 macOS「自動化」權限。
- **專案啟動只支援 iTerm2**，不使用「全域預設終端機」設定；沒有停止按鈕（關閉分頁或 Ctrl+C）。
- **規則層級的通知靜音**：以專案為單位靜音；規則自己的通知動作要靜音，請停用該規則或移除動作。
- 目前使用預設的 Electron 圖示，打包版未簽章也未公證。

## 貢獻與安全

歡迎參與，開發環境與送出 PR 前的檢查見 [`CONTRIBUTING.md`](CONTRIBUTING.md)。發現安全問題請依 [`SECURITY.md`](SECURITY.md) 私下回報，不要開公開 issue。

## 授權

以 [Apache License 2.0](LICENSE) 授權。
