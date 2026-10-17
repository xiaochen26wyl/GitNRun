import { IPC } from "@shared/ipc";
import { handleIpc } from "@main/ipc";
import { asGitLiteOverviewArgs } from "@main/ipc-validation";
import type { GitLiteHandlers } from "@main/git-lite/handlers";

export const registerGitLiteIpc = (handlers: GitLiteHandlers): void => {
  handleIpc(IPC.gitLiteOverview, asGitLiteOverviewArgs, (...args) => handlers.overview(args[0]));
};
