import { IPC } from "@shared/ipc";
import type { AppSettingsPatch } from "@shared/app-settings";
import type { AppSettingsHandlers } from "@main/app-settings";
import { handleIpc } from "@main/ipc";
import { asAppSettingsArgs, asBackupNameArgs, asNoArgs } from "@main/ipc-validation";

export const registerAppSettingsIpc = (handlers: AppSettingsHandlers): void => {
  handleIpc(IPC.appSettingsGet, asNoArgs, () => handlers.get());
  handleIpc(IPC.appSettingsSave, asAppSettingsArgs, (patch) => handlers.save(patch as AppSettingsPatch));
  handleIpc(IPC.appSettingsDataUsage, asNoArgs, () => handlers.dataUsage());
  handleIpc(IPC.backupsList, asNoArgs, () => handlers.listBackups());
  handleIpc(IPC.backupsNow, asNoArgs, () => handlers.backupNow());
  handleIpc(IPC.backupsRestore, asBackupNameArgs, (name) => handlers.restore(name));
  handleIpc(IPC.backupsDelete, asBackupNameArgs, (name) => handlers.deleteBackup(name));
  handleIpc(IPC.backupsDeleteAll, asNoArgs, () => handlers.deleteAllBackups());
};
