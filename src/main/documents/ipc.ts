import { IPC } from "@shared/ipc";
import { handleIpc } from "@main/ipc";
import { asDocumentOpenArgs, asDocumentShortcutArgs, asIdArgs, asNoArgs } from "@main/ipc-validation";
import type { DocumentHandlers } from "@main/documents/handlers";

export const registerDocumentIpc = (handlers: DocumentHandlers): void => {
  handleIpc(IPC.documentsList, asNoArgs, () => handlers.list());
  handleIpc(IPC.documentsSave, asDocumentShortcutArgs, (input) => handlers.save(input));
  handleIpc(IPC.documentsRemove, asIdArgs, (id) => handlers.remove(id));
  handleIpc(IPC.documentsOpen, asDocumentOpenArgs, (id) => handlers.open(id));
};
