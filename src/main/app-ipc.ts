import { IPC } from "@shared/ipc";
import type { AppHandlers } from "@main/app-handlers";
import { handleIpc } from "@main/ipc";
import {
  asBooleanArgs,
  asBranchRuleSaveArgs,
  asEventQueryArgs,
  asExternalLinkArgs,
  asIdArgs,
  asLogQueryArgs,
  asNoArgs,
  asProjectInputArgs,
  asProjectUpdateArgs,
  asScopeIdArgs,
  asStartWorkPreviewArgs,
  asStartWorkRunArgs
} from "@main/ipc-validation";
import { native } from "@main/native/bridge";

export const registerAppIpc = (handlers: AppHandlers): void => {
  handleIpc(IPC.projectsList, asNoArgs, () => handlers.listProjects());
  handleIpc(IPC.projectsAdd, asProjectInputArgs, (input) => handlers.addProject(input));
  handleIpc(IPC.projectsUpdate, asProjectUpdateArgs, (id, patch) => handlers.updateProject(id, patch));
  handleIpc(IPC.projectsRemove, asIdArgs, (id) => handlers.removeProject(id));

  handleIpc(IPC.eventsQuery, asEventQueryArgs, (query) => handlers.queryEvents(query));
  handleIpc(IPC.eventsGet, asIdArgs, (id) => handlers.getEvent(id));
  handleIpc(IPC.logsQuery, asLogQueryArgs, (query) => handlers.queryLogs(query));

  handleIpc(IPC.monitorStatus, asNoArgs, () => handlers.getMonitorStatus());
  handleIpc(IPC.monitorPollNow, asIdArgs, (id) => handlers.pollNow(id));
  handleIpc(IPC.monitorSetPaused, asBooleanArgs, (paused) => handlers.setPaused(paused));

  handleIpc(IPC.branchRuleGet, asScopeIdArgs, (scopeId) => handlers.getBranchRule(scopeId));
  handleIpc(IPC.branchRuleSave, asBranchRuleSaveArgs, (scopeId, input) => handlers.saveBranchRule(scopeId, input));
  handleIpc(IPC.branchRuleReset, asScopeIdArgs, (scopeId) => handlers.resetBranchRule(scopeId));
  handleIpc(IPC.startWorkPreview, asStartWorkPreviewArgs, (projectId, input) => handlers.previewStartWork(projectId, input));
  handleIpc(IPC.startWorkRun, asStartWorkRunArgs, (projectId, input, expected) =>
    handlers.runStartWork(projectId, input, expected)
  );

  // 網址已在驗證器限縮到 github.com/settings/，這裡不接受任何其他目標。
  handleIpc(IPC.externalOpen, asExternalLinkArgs, (url) => native().openExternal(url));
};
