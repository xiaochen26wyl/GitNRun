import { IPC } from "@shared/ipc";
import { handleIpc } from "@main/ipc";
import { asNoArgs } from "@main/ipc-validation";
import type { GitLiteHandlers } from "@main/git-lite/handlers";

export const registerGitLiteIpc = (handlers: GitLiteHandlers): void => {
  handleIpc(IPC.gitLiteOverview, asNoArgs, () => handlers.overview());
};
