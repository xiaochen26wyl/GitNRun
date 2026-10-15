import { IPC } from "@shared/ipc";
import { handleIpc } from "@main/ipc";
import { asNoArgs } from "@main/ipc-validation";
import type { BrandHandlers } from "@main/brand/handlers";

export const registerBrandIpc = (handlers: BrandHandlers): void => {
  handleIpc(IPC.brandColors, asNoArgs, () => handlers.colors());
};
