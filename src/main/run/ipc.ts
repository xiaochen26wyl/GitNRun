import { IPC } from "@shared/ipc";
import { handleIpc } from "@main/ipc";
import { asFolderPathArgs, asNoArgs, asRunAccountArgs, asRunActionArgs, asRunPasscodeBindingArgs, asRunTargetIdArgs } from "@main/ipc-validation";
import type { RunHandlers } from "@main/run/handlers";

export const registerRunIpc = (handlers: RunHandlers): void => {
  handleIpc(IPC.runOverview, asNoArgs, () => handlers.overview());
  handleIpc(IPC.runAction, asRunActionArgs, (targetId, action) => handlers.run(targetId, action));
  handleIpc(IPC.runAddFolder, asFolderPathArgs, (folder) => handlers.addFolder(folder));
  handleIpc(IPC.runRemoveFolder, asRunTargetIdArgs, (targetId) => handlers.removeFolder(targetId));
  handleIpc(IPC.runSetAccount, asRunAccountArgs, (targetId, account) => handlers.setAccount(targetId, account));
  handleIpc(IPC.runCopyPasscode, asRunTargetIdArgs, (targetId) => handlers.copyPasscode(targetId));
  handleIpc(IPC.runBindPasscode, asRunPasscodeBindingArgs, (targetId, binding) => handlers.bindPasscode(targetId, binding));
  handleIpc(IPC.runUnbindPasscode, asRunTargetIdArgs, (targetId) => handlers.unbindPasscode(targetId));
  handleIpc(IPC.runRecheckPasscode, asRunTargetIdArgs, (targetId) => handlers.recheckPasscode(targetId));
  handleIpc(IPC.runOpenPasscodeFile, asRunTargetIdArgs, (targetId) => handlers.openPasscodeFile(targetId));
  handleIpc(IPC.runScanPorts, asNoArgs, () => handlers.scanPorts());
  handleIpc(IPC.runReleasePorts, asNoArgs, () => handlers.releasePorts());
};
