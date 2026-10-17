import type { AiResult, AiSettings, AiUsage, ConflictReport, OutgoingPreview } from "@shared/ai";
import type { AppSettings, AppSettingsPatch, BackupOverview, DataUsage, RestoreSummary } from "@shared/app-settings";
import type { BranchRuleFormInput, BranchRuleView } from "@shared/branch-template";
import type { BrandColorMap } from "@shared/brand";
import type { CommandOutputEvent } from "@shared/command-output";
import type { DocumentShortcut, DocumentShortcutInput } from "@shared/documents";
import type { EventPage, EventQuery, PushEvent } from "@shared/events";
import type { GitLiteOverview, GitLiteOverviewOptions } from "@shared/git-lite";
import type { LogPage, LogQuery } from "@shared/logs";
import type { MonitorChange, MonitorStatus } from "@shared/monitor";
import type { PortSweepResult, PortSweepScan } from "@shared/port-sweep";
import type { Project, ProjectInput } from "@shared/projects";
import type { LaunchResult, LauncherSettings, TerminalAvailability, TerminalMapping, TerminalMappingInput } from "@shared/launcher";
import type { PasscodeBinding, RunAction, RunActionResult, RunOverview } from "@shared/run";
import type { DryRunReport, RuleExecution, RulePreviewReport, RulesExportResult, RulesImportResult } from "@shared/rule-runs";
import type { Rule, RuleInput } from "@shared/rules";
import type { SecretStatus, SecretTestResult, SecretsOverview } from "@shared/secrets";
import type { ProjectWebhookInfo, WebhookSettings, WebhookStatus } from "@shared/webhook";
import type { StartWorkInput, StartWorkPreview, StartWorkResult } from "@shared/start-work";

/**
 * IPC 通道與渲染層可呼叫的 API 型別，是主程序、preload、渲染層共用的唯一來源。
 * 新增功能的順序：在這裡宣告通道與型別 → 主程序 handle（含入參驗證）→ preload 實作 →
 * 渲染層只透過 window.gitNRun 呼叫。型別只在這裡寫一次，不再手動複製到 d.ts。
 */

export const IPC = {
  appInfo: "app:info",
  secretsOverview: "secrets:overview",
  secretsSet: "secrets:set",
  secretsDelete: "secrets:delete",
  secretsTest: "secrets:test",
  projectsList: "projects:list",
  projectsAdd: "projects:add",
  projectsUpdate: "projects:update",
  projectsRemove: "projects:remove",
  eventsQuery: "events:query",
  eventsGet: "events:get",
  logsQuery: "logs:query",
  monitorStatus: "monitor:status",
  monitorPollNow: "monitor:poll-now",
  monitorSetPaused: "monitor:set-paused",
  branchRuleGet: "branch-rules:get",
  branchRuleSave: "branch-rules:save",
  branchRuleReset: "branch-rules:reset",
  startWorkPreview: "start-work:preview",
  startWorkRun: "start-work:run",
  rulesList: "rules:list",
  rulesCreate: "rules:create",
  rulesUpdate: "rules:update",
  rulesDelete: "rules:delete",
  rulesSetEnabled: "rules:set-enabled",
  rulesReorder: "rules:reorder",
  rulesPreview: "rules:preview",
  rulesDryRun: "rules:dry-run",
  rulesExecutions: "rules:executions",
  rulesExport: "rules:export",
  rulesImport: "rules:import",
  launcherMappingsList: "launcher:mappings:list",
  launcherMappingSave: "launcher:mappings:save",
  launcherMappingDelete: "launcher:mappings:delete",
  launcherLaunchFolder: "launcher:launch-folder",
  launcherLaunchProject: "launcher:launch-project",
  launcherSettingsGet: "launcher:settings:get",
  launcherSettingsSave: "launcher:settings:save",
  launcherTerminals: "launcher:terminals",
  runOverview: "run:overview",
  runAction: "run:action",
  runAddFolder: "run:add-folder",
  runRemoveFolder: "run:remove-folder",
  runSetAccount: "run:set-account",
  runCopyPasscode: "run:copy-passcode",
  runBindPasscode: "run:bind-passcode",
  runUnbindPasscode: "run:unbind-passcode",
  runOpenPasscodeFile: "run:open-passcode-file",
  runScanPorts: "run:scan-ports",
  runReleasePorts: "run:release-ports",
  documentsList: "documents:list",
  documentsSave: "documents:save",
  documentsRemove: "documents:remove",
  documentsOpen: "documents:open",
  documentsGetRoot: "documents:get-root",
  documentsSetRoot: "documents:set-root",
  gitLiteOverview: "git-lite:overview",
  brandColors: "brand:colors",
  aiSettingsGet: "ai:settings:get",
  aiSettingsSave: "ai:settings:save",
  aiUsage: "ai:usage",
  aiPreviewCommit: "ai:preview-commit",
  aiCommitMessage: "ai:commit-message",
  aiSummarizeEvent: "ai:summarize-event",
  aiSuggestEvent: "ai:suggest-event",
  aiConflicts: "ai:conflicts",
  clipboardWrite: "clipboard:write",
  externalOpen: "external:open",
  webhookSettingsGet: "webhook:settings:get",
  webhookSettingsSave: "webhook:settings:save",
  webhookStatus: "webhook:status",
  webhookProjects: "webhook:projects",
  webhookGenerateSecret: "webhook:generate-secret",
  webhookRemoveSecret: "webhook:remove-secret",
  appSettingsGet: "app-settings:get",
  appSettingsSave: "app-settings:save",
  appSettingsDataUsage: "app-settings:data-usage",
  backupsList: "backups:list",
  backupsNow: "backups:now",
  backupsRestore: "backups:restore",
  backupsDelete: "backups:delete",
  backupsDeleteAll: "backups:delete-all"
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/** 主程序主動推給渲染層的通道（不是 invoke）。 */
export const PUSH = {
  monitorChanged: "monitor:changed",
  commandOutput: "command:output"
} as const;

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
}

/** 可更新的專案欄位；owner／repo 不可變更，要換 repo 請刪除後重新新增。 */
export type ProjectPatch = Partial<Omit<ProjectInput, "owner" | "repo">>;

/** 拖曳進來的檔案；只需要名稱，路徑由 preload 向 Electron 取得。 */
export interface DroppedFile {
  readonly name: string;
}

export interface LauncherSettingsPatch {
  shortcut?: string | null;
  defaultTerminal?: string;
  selectedProjectId?: number | null;
}

export interface GitNRunApi {
  getAppInfo(): Promise<AppInfo>;

  /** 只回傳狀態（是否已設定、末四碼、是否可讀），永遠不含明文或密文。 */
  getSecretsOverview(): Promise<SecretsOverview>;
  /** 單向：值送到主程序加密保存，之後再也讀不回來。遮罩值回送視為未變更。 */
  setSecret(name: string, value: string): Promise<SecretStatus>;
  deleteSecret(name: string): Promise<void>;
  testSecret(name: string): Promise<SecretTestResult>;

  listProjects(): Promise<Project[]>;
  addProject(input: ProjectInput): Promise<Project>;
  updateProject(id: number, patch: ProjectPatch): Promise<Project>;
  removeProject(id: number): Promise<void>;

  queryEvents(query: EventQuery): Promise<EventPage>;
  getEvent(id: number): Promise<PushEvent | null>;
  queryLogs(query: LogQuery): Promise<LogPage>;

  getMonitorStatus(): Promise<MonitorStatus>;
  pollProjectNow(id: number): Promise<void>;
  setMonitorPaused(paused: boolean): Promise<void>;
  /** scopeId 0 = 全域預設；其他 = 該專案。回傳目前生效的規則與這個範圍自己有沒有覆寫。 */
  getBranchRule(scopeId: number): Promise<BranchRuleView>;
  saveBranchRule(scopeId: number, input: BranchRuleFormInput): Promise<BranchRuleView>;
  /** 移除這個範圍自己的覆寫（全域則回到內建預設）。 */
  resetBranchRule(scopeId: number): Promise<BranchRuleView>;
  /** 唯讀：算出將建立的分支名稱與步驟，不改動任何東西。 */
  previewStartWork(projectId: number, input: StartWorkInput): Promise<StartWorkPreview>;
  /** 實際執行；expectedBranch 必須與預覽時看到的名稱一致，否則拒絕。 */
  runStartWork(projectId: number, input: StartWorkInput, expectedBranch: string): Promise<StartWorkResult>;

  listRules(): Promise<Rule[]>;
  createRule(input: RuleInput): Promise<Rule>;
  updateRule(id: number, input: RuleInput): Promise<Rule>;
  deleteRule(id: number): Promise<void>;
  setRuleEnabled(id: number, enabled: boolean): Promise<Rule>;
  /** 依傳入的順序重新排定優先順序；清單必須剛好是目前所有規則。 */
  reorderRules(orderedIds: number[]): Promise<Rule[]>;
  /** 用歷史事件看這條規則（尚未儲存也可以）會命中哪些。 */
  previewRule(input: RuleInput): Promise<RulePreviewReport>;
  /** 乾跑：只評估條件、列出動作會怎麼做，不執行任何動作。 */
  dryRunRule(input: RuleInput, eventId: number): Promise<DryRunReport>;
  listRuleExecutions(ruleId?: number): Promise<RuleExecution[]>;
  /** 由主程序開啟儲存視窗；匯出內容不含任何密鑰值。 */
  exportRules(): Promise<RulesExportResult>;
  /** 由主程序開啟選檔視窗；匯入的規則一律是停用、且需要確認的狀態。 */
  importRules(): Promise<RulesImportResult>;

  listTerminalMappings(): Promise<TerminalMapping[]>;
  saveTerminalMapping(input: TerminalMappingInput): Promise<TerminalMapping>;
  deleteTerminalMapping(id: number): Promise<void>;
  /** 在終端機開啟資料夾；有符合的映射就自動執行其指令。 */
  launchFolder(folder: string): Promise<LaunchResult>;
  launchProject(projectId: number): Promise<LaunchResult>;
  getLauncherSettings(): Promise<LauncherSettings>;
  saveLauncherSettings(patch: LauncherSettingsPatch): Promise<LauncherSettings>;
  getTerminalAvailability(): Promise<TerminalAvailability>;
  /** 專案啟動頁：所有專案、各服務的狀態與按鈕是否可按（狀態以 TCP 探測得出）。 */
  getRunOverview(): Promise<RunOverview>;
  /** 渲染層只傳專案識別、受限動作與服務名稱；指令、路徑、網址都由主程序決定。 */
  runProjectAction(targetId: string, action: RunAction): Promise<RunActionResult>;
  addRunFolder(folder: string): Promise<void>;
  removeRunFolder(targetId: string): Promise<void>;
  /** dev 通關帳號；空字串 = 清除。密碼不經過 GitNRun 保存，見 bindRunPasscode。 */
  setRunAccount(targetId: string, account: string): Promise<void>;
  /** 由主程序讀專案環境檔裡的 Debug 密碼並放進剪貼簿（60 秒後自動清除），渲染層拿不到明文。 */
  copyRunPasscode(targetId: string): Promise<void>;
  /** 指定 Debug 密碼讀哪個環境檔（相對專案的路徑）的哪個鍵；密碼只留在環境檔，GitNRun 只讀取。 */
  bindRunPasscode(targetId: string, binding: PasscodeBinding): Promise<void>;
  unbindRunPasscode(targetId: string): Promise<void>;
  /** 用文件編輯器開綁定的環境檔；路徑由主程序算出。 */
  openRunPasscodeFile(targetId: string): Promise<void>;
  /** 列出終端機手動開的 port 與占用它的程序（不結束任何東西）。 */
  scanTerminalPorts(): Promise<PortSweepScan>;
  /** 結束所有終端機手動開的 port 的程序；pid 由主程序重新掃描決定，渲染層不傳任何 pid。 */
  releaseTerminalPorts(): Promise<PortSweepResult>;
  listDocumentShortcuts(): Promise<DocumentShortcut[]>;
  saveDocumentShortcut(input: DocumentShortcutInput): Promise<DocumentShortcut>;
  removeDocumentShortcut(id: number): Promise<void>;
  openDocumentShortcut(id: number): Promise<void>;
  /** 專案根目錄：底下每個含 .git 的子資料夾都會自動掃 README；空字串 = 關閉。 */
  getDocumentRoot(): Promise<string>;
  setDocumentRoot(path: string): Promise<string>;
  /** options.issues 為 false 時只讀本機 git 狀態、不呼叫 GitHub；省略時連 issues 一起讀。 */
  getGitLiteOverview(options?: GitLiteOverviewOptions): Promise<GitLiteOverview>;
  /** 各專案 README「品牌配色 → 主要配色」的主色：資料夾（已正規化）→ 大寫 #RRGGBB，沒有品牌色的資料夾不會出現。 */
  getBrandColors(): Promise<BrandColorMap>;
  /** 拖曳進視窗的檔案／資料夾的本機路徑（Electron 不再提供 File.path，要透過 preload 取得）。 */
  pathForFile(file: DroppedFile): string;

  getAiSettings(): Promise<AiSettings>;
  saveAiSettings(settings: AiSettings): Promise<AiSettings>;
  getAiUsage(): Promise<AiUsage>;
  /** 唯讀：這次會送給 AI 的內容（已排除、已遮蔽）；沒有變更時為 null。 */
  previewAiCommit(projectId: number): Promise<OutgoingPreview | null>;
  /** 專案需已在專案列表開啟「允許 AI 分析」；否則回傳本機規則的結果並說明原因。 */
  generateCommitMessage(projectId: number): Promise<AiResult>;
  summarizeEventWithAi(eventId: number): Promise<AiResult>;
  suggestForEvent(eventId: number): Promise<AiResult>;
  predictConflicts(projectId: number, against?: string): Promise<ConflictReport>;
  copyText(text: string): Promise<void>;
  /** 用系統瀏覽器開啟網址；主程序只放行 https://github.com/settings/ 底下的頁面（建立 token 的教學用）。 */
  openExternalLink(url: string): Promise<void>;

  getWebhookSettings(): Promise<WebhookSettings>;
  saveWebhookSettings(settings: WebhookSettings): Promise<WebhookSettings>;
  getWebhookStatus(): Promise<WebhookStatus>;
  getWebhookProjects(): Promise<ProjectWebhookInfo[]>;
  /** 產生新的簽章 secret 並直接放進剪貼簿（60 秒後清除）；secret 不會顯示在畫面上。 */
  generateWebhookSecret(projectId: number): Promise<{ copied: true }>;
  removeWebhookSecret(projectId: number): Promise<void>;

  getAppSettings(): Promise<AppSettings>;
  saveAppSettings(patch: AppSettingsPatch): Promise<AppSettings>;
  getDataUsage(): Promise<DataUsage>;
  listBackups(): Promise<BackupOverview>;
  backupNow(): Promise<{ written: boolean }>;
  /** 只能還原備份資料夾裡的檔案；還原後規則一律回到「寫入動作需確認」。金鑰不在備份裡，需重新輸入。 */
  restoreBackup(name: string): Promise<RestoreSummary>;
  /** 只能刪備份資料夾裡的備份檔；刪除不會關閉每日自動備份。 */
  deleteBackup(name: string): Promise<void>;
  /** 刪除全部備份，回傳實際刪掉的份數。 */
  deleteAllBackups(): Promise<{ removed: number }>;

  /** 有新事件或狀態變動時通知；回傳取消訂閱的函式。 */
  onMonitorChanged(handler: (change: MonitorChange) => void): () => void;
  /** 規則執行指令時的即時輸出（已脫敏、逐行、批次送出）。 */
  onCommandOutput(handler: (events: CommandOutputEvent[]) => void): () => void;
}
