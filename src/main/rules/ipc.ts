import { readFile, writeFile } from "node:fs/promises";
import { BrowserWindow, dialog } from "electron";
import { IPC } from "@shared/ipc";
import type { RulesExportResult, RulesImportResult } from "@shared/rule-runs";
import { UserFacingError } from "@main/errors";
import { handleIpc } from "@main/ipc";
import {
  asIdArgs,
  asNoArgs,
  asOptionalIdArgs,
  asReorderArgs,
  asRuleDryRunArgs,
  asRuleEnabledArgs,
  asRuleObjectArgs,
  asRuleUpdateArgs
} from "@main/ipc-validation";
import { MAX_RULES_FILE_BYTES, type RulesHandlers } from "@main/rules/handlers";

const focusedWindow = (): BrowserWindow | undefined => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];

const exportRules = async (handlers: RulesHandlers): Promise<RulesExportResult> => {
  const options = {
    title: "匯出規則",
    defaultPath: "gitnrun-rules.json",
    filters: [{ name: "GitNRun 規則", extensions: ["json"] }]
  };
  const window = focusedWindow();
  const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) {
    return { saved: false };
  }
  // 匯出檔不含密鑰，但仍只給擁有者讀寫。
  await writeFile(result.filePath, handlers.exportText(), { mode: 0o600 });
  return { saved: true, path: result.filePath };
};

const importRules = async (handlers: RulesHandlers): Promise<RulesImportResult> => {
  const options = {
    title: "匯入規則",
    properties: ["openFile" as const],
    filters: [{ name: "GitNRun 規則", extensions: ["json"] }]
  };
  const window = focusedWindow();
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  const [filePath] = result.filePaths;
  if (result.canceled || !filePath) {
    return { cancelled: true };
  }
  const buffer = await readFile(filePath);
  if (buffer.length > MAX_RULES_FILE_BYTES) {
    throw new UserFacingError("檔案太大，不像是規則匯出檔");
  }
  return { cancelled: false, ...handlers.importText(buffer.toString("utf8")) };
};

export const registerRulesIpc = (handlers: RulesHandlers): void => {
  handleIpc(IPC.rulesList, asNoArgs, () => handlers.list());
  handleIpc(IPC.rulesCreate, asRuleObjectArgs, (input) => handlers.create(input));
  handleIpc(IPC.rulesUpdate, asRuleUpdateArgs, (id, input) => handlers.update(id, input));
  handleIpc(IPC.rulesDelete, asIdArgs, (id) => handlers.remove(id));
  handleIpc(IPC.rulesSetEnabled, asRuleEnabledArgs, (id, enabled) => handlers.setEnabled(id, enabled));
  handleIpc(IPC.rulesReorder, asReorderArgs, (ids) => handlers.reorder(ids));
  handleIpc(IPC.rulesPreview, asRuleObjectArgs, (input) => handlers.preview(input));
  handleIpc(IPC.rulesDryRun, asRuleDryRunArgs, (input, eventId) => handlers.dryRun(input, eventId));
  handleIpc(IPC.rulesExecutions, asOptionalIdArgs, (ruleId) => handlers.executions(ruleId));
  handleIpc(IPC.rulesExport, asNoArgs, () => exportRules(handlers));
  handleIpc(IPC.rulesImport, asNoArgs, () => importRules(handlers));
};
