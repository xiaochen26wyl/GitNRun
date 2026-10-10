import type { GitNRunApi } from "@shared/ipc";

declare global {
  interface Window {
    gitNRun: GitNRunApi;
  }
}

export {};
