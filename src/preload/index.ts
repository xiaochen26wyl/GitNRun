import { contextBridge, ipcRenderer, webUtils } from "electron";
import { IPC, PUSH, type GitNRunApi } from "@shared/ipc";
import type { CommandOutputEvent } from "@shared/command-output";
import type { MonitorChange } from "@shared/monitor";

// 只暴露 shared/ipc 宣告過的方法；渲染層看不到 ipcRenderer，也不能自選通道。
const api: GitNRunApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo),

  getSecretsOverview: () => ipcRenderer.invoke(IPC.secretsOverview),
  setSecret: (name, value) => ipcRenderer.invoke(IPC.secretsSet, name, value),
  deleteSecret: (name) => ipcRenderer.invoke(IPC.secretsDelete, name),
  testSecret: (name) => ipcRenderer.invoke(IPC.secretsTest, name),

  listProjects: () => ipcRenderer.invoke(IPC.projectsList),
  addProject: (input) => ipcRenderer.invoke(IPC.projectsAdd, input),
  updateProject: (id, patch) => ipcRenderer.invoke(IPC.projectsUpdate, id, patch),
  removeProject: (id) => ipcRenderer.invoke(IPC.projectsRemove, id),

  queryEvents: (query) => ipcRenderer.invoke(IPC.eventsQuery, query),
  getEvent: (id) => ipcRenderer.invoke(IPC.eventsGet, id),
  queryLogs: (query) => ipcRenderer.invoke(IPC.logsQuery, query),

  getMonitorStatus: () => ipcRenderer.invoke(IPC.monitorStatus),
  pollProjectNow: (id) => ipcRenderer.invoke(IPC.monitorPollNow, id),
  setMonitorPaused: (paused) => ipcRenderer.invoke(IPC.monitorSetPaused, paused),
  getBranchRule: (scopeId) => ipcRenderer.invoke(IPC.branchRuleGet, scopeId),
  saveBranchRule: (scopeId, input) => ipcRenderer.invoke(IPC.branchRuleSave, scopeId, input),
  resetBranchRule: (scopeId) => ipcRenderer.invoke(IPC.branchRuleReset, scopeId),
  previewStartWork: (projectId, input) => ipcRenderer.invoke(IPC.startWorkPreview, projectId, input),
  runStartWork: (projectId, input, expectedBranch) => ipcRenderer.invoke(IPC.startWorkRun, projectId, input, expectedBranch),
  listRules: () => ipcRenderer.invoke(IPC.rulesList),
  createRule: (input) => ipcRenderer.invoke(IPC.rulesCreate, input),
  updateRule: (id, input) => ipcRenderer.invoke(IPC.rulesUpdate, id, input),
  deleteRule: (id) => ipcRenderer.invoke(IPC.rulesDelete, id),
  setRuleEnabled: (id, enabled) => ipcRenderer.invoke(IPC.rulesSetEnabled, id, enabled),
  reorderRules: (orderedIds) => ipcRenderer.invoke(IPC.rulesReorder, orderedIds),
  previewRule: (input) => ipcRenderer.invoke(IPC.rulesPreview, input),
  dryRunRule: (input, eventId) => ipcRenderer.invoke(IPC.rulesDryRun, input, eventId),
  listRuleExecutions: (ruleId) => (ruleId === undefined ? ipcRenderer.invoke(IPC.rulesExecutions) : ipcRenderer.invoke(IPC.rulesExecutions, ruleId)),
  exportRules: () => ipcRenderer.invoke(IPC.rulesExport),
  importRules: () => ipcRenderer.invoke(IPC.rulesImport),
  listTerminalMappings: () => ipcRenderer.invoke(IPC.launcherMappingsList),
  saveTerminalMapping: (input) => ipcRenderer.invoke(IPC.launcherMappingSave, input),
  deleteTerminalMapping: (id) => ipcRenderer.invoke(IPC.launcherMappingDelete, id),
  launchFolder: (folder) => ipcRenderer.invoke(IPC.launcherLaunchFolder, folder),
  launchProject: (projectId) => ipcRenderer.invoke(IPC.launcherLaunchProject, projectId),
  getLauncherSettings: () => ipcRenderer.invoke(IPC.launcherSettingsGet),
  saveLauncherSettings: (patch) => ipcRenderer.invoke(IPC.launcherSettingsSave, patch),
  getTerminalAvailability: () => ipcRenderer.invoke(IPC.launcherTerminals),
  getRunOverview: () => ipcRenderer.invoke(IPC.runOverview),
  runProjectAction: (targetId, action) => ipcRenderer.invoke(IPC.runAction, targetId, action),
  addRunFolder: (folder) => ipcRenderer.invoke(IPC.runAddFolder, folder),
  removeRunFolder: (targetId) => ipcRenderer.invoke(IPC.runRemoveFolder, targetId),
  setRunAccount: (targetId, account) => ipcRenderer.invoke(IPC.runSetAccount, targetId, account),
  copyRunPasscode: (targetId) => ipcRenderer.invoke(IPC.runCopyPasscode, targetId),
  listDocumentShortcuts: () => ipcRenderer.invoke(IPC.documentsList),
  saveDocumentShortcut: (input) => ipcRenderer.invoke(IPC.documentsSave, input),
  removeDocumentShortcut: (id) => ipcRenderer.invoke(IPC.documentsRemove, id),
  openDocumentShortcut: (id) => ipcRenderer.invoke(IPC.documentsOpen, id),
  getGitLiteOverview: () => ipcRenderer.invoke(IPC.gitLiteOverview),
  pathForFile: (file) => webUtils.getPathForFile(file as File),
  getAiSettings: () => ipcRenderer.invoke(IPC.aiSettingsGet),
  saveAiSettings: (settings) => ipcRenderer.invoke(IPC.aiSettingsSave, settings),
  getAiUsage: () => ipcRenderer.invoke(IPC.aiUsage),
  previewAiCommit: (projectId) => ipcRenderer.invoke(IPC.aiPreviewCommit, projectId),
  generateCommitMessage: (projectId) => ipcRenderer.invoke(IPC.aiCommitMessage, projectId),
  summarizeEventWithAi: (eventId) => ipcRenderer.invoke(IPC.aiSummarizeEvent, eventId),
  suggestForEvent: (eventId) => ipcRenderer.invoke(IPC.aiSuggestEvent, eventId),
  predictConflicts: (projectId, against) =>
    against === undefined ? ipcRenderer.invoke(IPC.aiConflicts, projectId) : ipcRenderer.invoke(IPC.aiConflicts, projectId, against),
  copyText: (text) => ipcRenderer.invoke(IPC.clipboardWrite, text),
  getWebhookSettings: () => ipcRenderer.invoke(IPC.webhookSettingsGet),
  saveWebhookSettings: (settings) => ipcRenderer.invoke(IPC.webhookSettingsSave, settings),
  getWebhookStatus: () => ipcRenderer.invoke(IPC.webhookStatus),
  getWebhookProjects: () => ipcRenderer.invoke(IPC.webhookProjects),
  generateWebhookSecret: (projectId) => ipcRenderer.invoke(IPC.webhookGenerateSecret, projectId),
  removeWebhookSecret: (projectId) => ipcRenderer.invoke(IPC.webhookRemoveSecret, projectId),
  getAppSettings: () => ipcRenderer.invoke(IPC.appSettingsGet),
  saveAppSettings: (patch) => ipcRenderer.invoke(IPC.appSettingsSave, patch),
  listBackups: () => ipcRenderer.invoke(IPC.backupsList),
  backupNow: () => ipcRenderer.invoke(IPC.backupsNow),
  restoreBackup: (name) => ipcRenderer.invoke(IPC.backupsRestore, name),
  onMonitorChanged: (handler) => {
    // 不把 IPC 事件物件交給渲染層，只轉交資料。
    const listener = (_event: unknown, change: MonitorChange): void => handler(change);
    ipcRenderer.on(PUSH.monitorChanged, listener);
    return () => {
      ipcRenderer.removeListener(PUSH.monitorChanged, listener);
    };
  },
  onCommandOutput: (handler) => {
    const listener = (_event: unknown, events: CommandOutputEvent[]): void => handler(events);
    ipcRenderer.on(PUSH.commandOutput, listener);
    return () => {
      ipcRenderer.removeListener(PUSH.commandOutput, listener);
    };
  }
};

contextBridge.exposeInMainWorld("gitNRun", api);
