# Electron → Tauri 遷移對照表

本表是遷移的唯一對照表：每完成一個變更要求，就把對應列的「狀態」改為「完成」。
通道表由 `src/shared/ipc.ts` 與（已移除的）`src/preload/index.ts` 產生，`tests/migration-inventory.test.ts` 會檢查每個通道恰好出現一次。

目標架構：渲染層（WKWebView）→ Rust 殼（`src-tauri`）→ unix socket → Node sidecar（現有 `src/main` 核心）。

## UI 結構（`src/renderer/App.tsx`，遷移時渲染層結構不改）

```
┌ topbar ───────────────────────────────────────────────────────────┐
│ [logo] GitNRun v版本   tabs: Free｜SAAS｜創作者宇宙｜                  │
│                              遊戲需要美術｜(其他，有未分組專案才出現)  │
│                              ｜Claude｜設定                         │
└───────────────────────────────────────────────────────────────────┘
main.content ─┬─ 分組頁籤 ──► RunView(group)
              │   ├ 警告列：找不到 iTerm2 / 空狀態 / 錯誤與結果訊息
              │   ├ list-tools：RunSortSwitch｜[調整順序]｜☐顯示 GitHub issues
              │   ├ RunOrderEditor（調整順序時取代列表，列表只 hidden 不卸載）
              │   └ project-list ─ TargetRow × N
              │       ├ run-project-title：專案名｜README｜DebugAccountActions
              │       │   ｜DebugPasswordActions｜釋放全部 port｜重裝依賴
              │       │   ｜PathCopyButton｜「啟動設定有誤」徽章
              │       ├ ChangeBadge（變更檔案數）
              │       ├ run-service × N（啟動/重啟/停止、指令、port、
              │       │   iOS 裝置列 run-devices、平台 run-platform）
              │       └ IssueSection（GitHub Issues，可關閉）
              ├─ Claude ──► ClaudeView：COMMAND_GROUPS 每組 section
              │             ＋ code／說明／[複製] 列（呼叫 copyText）
              └─ 設定 ───► settings-page（由上而下）
                            PortSweepPanel「終端機 port」
                            GeneralPanel「一般」：資料保留｜專案根目錄｜設定備份
                            LogsView「日誌」（篩選＋log-list＋載入更多）
                            SecretsPanel「金鑰」
共用小元件：HelpTip、LiveOutput、ChangeBadge
```

未掛載、遷移時只保證可編譯的元件：RulesView、RuleEditor、EventsView、ProjectsView、GitHubView、TerminalView、AiPanel、AiAssist、BranchRulesPanel、StartWorkPanel、WebhookPanel。
樣式單一來源：`src/renderer/styles.css`。

## 行程與資料流

```
現在： renderer ─window.gitNRun(preload)─► Electron main（核心 TS ＋ 原生能力同一行程）
目標： renderer(WKWebView)
         │ window.gitNRun（shim，位置參數不變）
         ▼ invoke / listen
       Rust 殼 src-tauri：視窗、選單、Dock、Keychain、通知、快捷鍵、對話框、
         │   單一指令 ipc_invoke（驗來源與通道）
         ▼ unix socket（NDJSON，token 驗證）
       Node sidecar：現有 src/main 核心原樣
         └ 需要原生能力時 → 反向呼叫 Rust（NativeBridge 遠端實作）
```

## IPC invoke 通道（84 個）

| 通道 | `window.gitNRun` 方法 | `IPC` 鍵 | 狀態 |
|------|------|------|------|
| `app:info` | `getAppInfo` | `appInfo` | 待辦 |
| `secrets:overview` | `getSecretsOverview` | `secretsOverview` | 待辦 |
| `secrets:set` | `setSecret` | `secretsSet` | 待辦 |
| `secrets:delete` | `deleteSecret` | `secretsDelete` | 待辦 |
| `secrets:test` | `testSecret` | `secretsTest` | 待辦 |
| `projects:list` | `listProjects` | `projectsList` | 待辦 |
| `projects:add` | `addProject` | `projectsAdd` | 待辦 |
| `projects:update` | `updateProject` | `projectsUpdate` | 待辦 |
| `projects:remove` | `removeProject` | `projectsRemove` | 待辦 |
| `events:query` | `queryEvents` | `eventsQuery` | 待辦 |
| `events:get` | `getEvent` | `eventsGet` | 待辦 |
| `logs:query` | `queryLogs` | `logsQuery` | 待辦 |
| `monitor:status` | `getMonitorStatus` | `monitorStatus` | 待辦 |
| `monitor:poll-now` | `pollProjectNow` | `monitorPollNow` | 待辦 |
| `monitor:set-paused` | `setMonitorPaused` | `monitorSetPaused` | 待辦 |
| `branch-rules:get` | `getBranchRule` | `branchRuleGet` | 待辦 |
| `branch-rules:save` | `saveBranchRule` | `branchRuleSave` | 待辦 |
| `branch-rules:reset` | `resetBranchRule` | `branchRuleReset` | 待辦 |
| `start-work:preview` | `previewStartWork` | `startWorkPreview` | 待辦 |
| `start-work:run` | `runStartWork` | `startWorkRun` | 待辦 |
| `rules:list` | `listRules` | `rulesList` | 待辦 |
| `rules:create` | `createRule` | `rulesCreate` | 待辦 |
| `rules:update` | `updateRule` | `rulesUpdate` | 待辦 |
| `rules:delete` | `deleteRule` | `rulesDelete` | 待辦 |
| `rules:set-enabled` | `setRuleEnabled` | `rulesSetEnabled` | 待辦 |
| `rules:reorder` | `reorderRules` | `rulesReorder` | 待辦 |
| `rules:preview` | `previewRule` | `rulesPreview` | 待辦 |
| `rules:dry-run` | `dryRunRule` | `rulesDryRun` | 待辦 |
| `rules:executions` | `listRuleExecutions` | `rulesExecutions` | 待辦 |
| `rules:export` | `exportRules` | `rulesExport` | 待辦 |
| `rules:import` | `importRules` | `rulesImport` | 待辦 |
| `launcher:mappings:list` | `listTerminalMappings` | `launcherMappingsList` | 待辦 |
| `launcher:mappings:save` | `saveTerminalMapping` | `launcherMappingSave` | 待辦 |
| `launcher:mappings:delete` | `deleteTerminalMapping` | `launcherMappingDelete` | 待辦 |
| `launcher:launch-folder` | `launchFolder` | `launcherLaunchFolder` | 待辦 |
| `launcher:launch-project` | `launchProject` | `launcherLaunchProject` | 待辦 |
| `launcher:settings:get` | `getLauncherSettings` | `launcherSettingsGet` | 待辦 |
| `launcher:settings:save` | `saveLauncherSettings` | `launcherSettingsSave` | 待辦 |
| `launcher:terminals` | `getTerminalAvailability` | `launcherTerminals` | 待辦 |
| `run:overview` | `getRunOverview` | `runOverview` | 待辦 |
| `run:action` | `runProjectAction` | `runAction` | 待辦 |
| `run:add-folder` | `addRunFolder` | `runAddFolder` | 待辦 |
| `run:remove-folder` | `removeRunFolder` | `runRemoveFolder` | 待辦 |
| `run:set-account` | `setRunAccount` | `runSetAccount` | 待辦 |
| `run:copy-passcode` | `copyRunPasscode` | `runCopyPasscode` | 待辦 |
| `run:bind-passcode` | `bindRunPasscode` | `runBindPasscode` | 待辦 |
| `run:unbind-passcode` | `unbindRunPasscode` | `runUnbindPasscode` | 待辦 |
| `run:recheck-passcode` | `recheckRunPasscode` | `runRecheckPasscode` | 待辦 |
| `run:open-passcode-file` | `openRunPasscodeFile` | `runOpenPasscodeFile` | 待辦 |
| `run:scan-ports` | `scanTerminalPorts` | `runScanPorts` | 待辦 |
| `run:release-ports` | `releaseTerminalPorts` | `runReleasePorts` | 待辦 |
| `documents:list` | `listDocumentShortcuts` | `documentsList` | 待辦 |
| `documents:save` | `saveDocumentShortcut` | `documentsSave` | 待辦 |
| `documents:remove` | `removeDocumentShortcut` | `documentsRemove` | 待辦 |
| `documents:open` | `openDocumentShortcut` | `documentsOpen` | 待辦 |
| `documents:get-root` | `getDocumentRoot` | `documentsGetRoot` | 待辦 |
| `documents:set-root` | `setDocumentRoot` | `documentsSetRoot` | 待辦 |
| `git-lite:overview` | `getGitLiteOverview` | `gitLiteOverview` | 待辦 |
| `brand:colors` | `getBrandColors` | `brandColors` | 待辦 |
| `ai:settings:get` | `getAiSettings` | `aiSettingsGet` | 待辦 |
| `ai:settings:save` | `saveAiSettings` | `aiSettingsSave` | 待辦 |
| `ai:usage` | `getAiUsage` | `aiUsage` | 待辦 |
| `ai:preview-commit` | `previewAiCommit` | `aiPreviewCommit` | 待辦 |
| `ai:commit-message` | `generateCommitMessage` | `aiCommitMessage` | 待辦 |
| `ai:summarize-event` | `summarizeEventWithAi` | `aiSummarizeEvent` | 待辦 |
| `ai:suggest-event` | `suggestForEvent` | `aiSuggestEvent` | 待辦 |
| `ai:conflicts` | `predictConflicts` | `aiConflicts` | 待辦 |
| `clipboard:write` | `copyText` | `clipboardWrite` | 待辦 |
| `external:open` | `openExternalLink` | `externalOpen` | 待辦 |
| `notify:show` | `showDesktopNotification` | `notifyShow` | 待辦 |
| `webhook:settings:get` | `getWebhookSettings` | `webhookSettingsGet` | 待辦 |
| `webhook:settings:save` | `saveWebhookSettings` | `webhookSettingsSave` | 待辦 |
| `webhook:status` | `getWebhookStatus` | `webhookStatus` | 待辦 |
| `webhook:projects` | `getWebhookProjects` | `webhookProjects` | 待辦 |
| `webhook:generate-secret` | `generateWebhookSecret` | `webhookGenerateSecret` | 待辦 |
| `webhook:remove-secret` | `removeWebhookSecret` | `webhookRemoveSecret` | 待辦 |
| `app-settings:get` | `getAppSettings` | `appSettingsGet` | 待辦 |
| `app-settings:save` | `saveAppSettings` | `appSettingsSave` | 待辦 |
| `app-settings:data-usage` | `getDataUsage` | `appSettingsDataUsage` | 待辦 |
| `backups:list` | `listBackups` | `backupsList` | 待辦 |
| `backups:now` | `backupNow` | `backupsNow` | 待辦 |
| `backups:restore` | `restoreBackup` | `backupsRestore` | 待辦 |
| `backups:delete` | `deleteBackup` | `backupsDelete` | 待辦 |
| `backups:delete-all` | `deleteAllBackups` | `backupsDeleteAll` | 待辦 |

## IPC 推播通道（2 個）

| 通道 | 訂閱方法 | 狀態 |
|------|------|------|
| `monitor:changed` | `onMonitorChanged` | 待辦 |
| `command:output` | `onCommandOutput` | 待辦 |

另有 `pathForFile`（Electron `webUtils`，不走 IPC；Tauri 回傳空字串，目前僅未掛載的 `TerminalView` 使用）。

## 原生橋接（`src/main/native/bridge.ts` 的 `NativeBridge`，20 項）

| 能力 | 主要呼叫端 | Tauri 端 | 狀態 |
|------|------|------|------|
| `appInfo`、`dataDir` | bootstrap、data-layer、process-guards | Rust 提供，沿用 `~/Library/Application Support/GitNRun` | 完成（變更要求 2、4） |
| `push` | broadcast | sidecar → Rust → `emit` | 完成（變更要求 4） |
| `focusMainWindow` | bootstrap、通知點擊 | Rust 視窗聚焦 | 完成（實測） |
| `confirm` | launcher/runtime、rules/confirm-dialog、run/runtime | NSAlert，逾時用 GCD 主佇列 abortModal | 完成（實測：按鈕、逾時中止、立即取消） |
| `showSaveDialog`、`showOpenFileDialog` | rules/ipc（匯出／匯入） | dialog 外掛（僅 Rust 端） | 完成（實測：取消路徑） |
| `showErrorBox` | process-guards | NSAlert 單鈕 | 完成（實測） |
| `bounceDock` | rules/confirm-dialog、run/runtime | NSApp requestUserAttention | 完成（呼叫成功，視覺效果未量） |
| `notify` | notifier | notification 外掛（點擊聚焦待人工驗證） | 完成顯示；點擊聚焦待你在打包版手動確認 |
| `clipboardWrite`、`clipboardWriteExpiring` | ai/ipc、clipboard-secret | clipboard 外掛，到期計時器在 Rust | 完成（實測：到期清除、不誤刪新內容） |
| `openExternal` | app-ipc、run/runtime | opener（白名單留在 sidecar） | 已實作；未實測開啟（避免實際開瀏覽器） |
| `shortcutRegister`、`shortcutUnregister`、`shortcutUnregisterAll` | launcher/runtime | global-shortcut ＋ accelerator 正規化 | 完成（實測：真的按鍵、占用、取消註冊） |
| `popupMenu` | launcher/runtime | non-activating NSPanel ＋ 合成右鍵 | 完成（實測：app 在背景也能彈出並選取） |
| `registerUrlScheme` | launcher/runtime | Info.plist scheme（僅 /Applications 內有效） | Info.plist 完成並驗證內容；系統登記待你安裝後確認 |
| `relaunch`、`exit` | process-guards | sidecar 結束碼 75／78，由 Rust 監督器處理 | 完成（Rust 依結束碼 0／75／78 處理，crash loop 額度有測試） |

## Electron 專屬行為

| 行為 | 來源 | Tauri 端 | 狀態 |
|------|------|------|------|
| 視窗大小、標題 | `src/main/window.ts` | tauri.conf ＋ Rust 明確設標題 | 完成（變更要求 4） |
| 關閉視窗不結束、Dock 重開 | `src/main/index.ts` | `RunEvent::Reopen` | 完成（Dock 重開未手動點過） |
| 單一實例 | `index.ts` | single-instance 外掛 | 完成（未手動啟動第二份） |
| `open-url`／`open-file` 冷啟動排隊 | `index.ts`、`launcher/external.ts` | `RunEvent::Opened` 先排隊 | 佇列邏輯完成並有測試；實機待你安裝 dmg 後確認 |
| 導航與權限封鎖、CSP | `window-hardening.ts`、`navigation-policy.ts`、`web-preferences.ts` | 導航白名單、capabilities 只授權 `ipc_invoke` | 導航白名單與 capabilities 完成；打包版嚴格 CSP 下 IPC 實測可通，最終 CSP 於變更要求 8 定稿 |
| 渲染程序終止重載 | `index.ts`（child-process-gone） | `on_web_content_process_terminate` | 完成（實測：前 3 次重載、第 4 次停止） |
| 預設選單、快捷鍵、縮放、開發者工具 | Electron 預設選單 | 明確的 App／Edit／View／Window 選單 | 完成（變更要求 4） |
| 密鑰加密 | `vault/safe-storage-cipher.ts` | AES-256-GCM（`gnr2:`），主金鑰在 Keychain | 完成（Keychain，開發版也用 Keychain；授權提示 90 秒逾時） |
| 開發版 Dock 圖示 | `index.ts` | 以 `build/icon.png` 設定 | 已實作；未目視確認 |
| iOS 模擬器視窗（osascript／Accessibility） | `run/simulator-window.ts` | 授權綁 App 身分，換殼後需重新授權，UI 要提示 | 待辦 |

## RAM 基準

量測日期 2026-10-24，數字為 `footprint -p` 的中位數（MB），Tauri 為 release 殼加 esbuild 核心（等同打包版）。RSS 在 macOS 會被壓縮記憶體低估，不採用。

| 情境 | Electron | Electron + V8 旗標（僅量測，未寫入程式碼） | Tauri | Tauri + 核心旗標 |
|------|------|------|------|------|
| 閒置（停在專案啟動頁） | 178 | 157 | 248（量測時整機高負載，偏高） | 123 |
| 逛完所有頁籤 | 310 | 230 | 313 | 139 |
| 啟動 3 個服務後 | 未量測 | 未量測 | 未量測 | 未量測 |

旗標為 `--max-semi-space-size=1 --max-old-space-size=128`（Tauri 套在核心 Node，Electron 套在主程序與渲染程序）。核心 JS 存活堆積強制 GC 後約 7 MB、無洩漏，記憶體大宗是 V8 新生代鬆弛。

結論：只換殼幾乎不省（313 vs 310）；省記憶體主要來自旗標，加旗標後 Tauri 比 Electron 少約 91 MB（約 40%）。逛完頁籤（加旗標）組成：Tauri 殼 32 + 核心 52 + WebKit 54；Electron 主程序與核心 80 + 渲染 116 + GPU／網路 33。
