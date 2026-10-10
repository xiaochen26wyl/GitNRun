import { IPC } from "@shared/ipc";
import { handleIpc } from "@main/ipc";
import { asFolderPathArgs, asIdArgs, asLauncherSettingsArgs, asNoArgs, asRuleObjectArgs } from "@main/ipc-validation";
import type { LauncherHandlers } from "@main/launcher/handlers";

export const registerLauncherIpc = (handlers: LauncherHandlers): void => {
  handleIpc(IPC.launcherMappingsList, asNoArgs, () => handlers.listMappings());
  // 映射內容的細部驗證與錯誤訊息由處理器負責（要回報給使用者），這裡只確認形狀。
  handleIpc(IPC.launcherMappingSave, asRuleObjectArgs, (input) => handlers.saveMapping(input));
  handleIpc(IPC.launcherMappingDelete, asIdArgs, (id) => handlers.deleteMapping(id));
  handleIpc(IPC.launcherLaunchFolder, asFolderPathArgs, (folder) => handlers.launchFolder(folder));
  handleIpc(IPC.launcherLaunchProject, asIdArgs, (id) => handlers.launchProject(id));
  handleIpc(IPC.launcherSettingsGet, asNoArgs, () => handlers.getSettings());
  handleIpc(IPC.launcherSettingsSave, asLauncherSettingsArgs, (patch) => handlers.saveSettings(patch));
  handleIpc(IPC.launcherTerminals, asNoArgs, () => handlers.availability());
};
