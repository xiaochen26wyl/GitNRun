import { DEFAULT_SHORTCUT, TERMINAL_APP_TERMINAL, isValidAccelerator, isValidTerminalChoice } from "@shared/launcher";
import type { Db } from "@main/db/database";
import { getSetting, setSetting } from "@main/db/settings-repo";

export const LAUNCHER_KEYS = {
  shortcut: "launcher.shortcut",
  defaultTerminal: "launcher.defaultTerminal",
  selectedProjectId: "launcher.selectedProjectId"
} as const;

export interface StoredLauncherSettings {
  shortcut: string | null;
  defaultTerminal: string;
  selectedProjectId: number | null;
}

/** 讀設定時一律重新驗證，資料庫裡被改壞的值會退回預設，不會讓啟動流程出錯。 */
export const readLauncherSettings = (db: Db): StoredLauncherSettings => {
  const shortcut = getSetting<unknown>(db, LAUNCHER_KEYS.shortcut, DEFAULT_SHORTCUT);
  const terminal = getSetting<unknown>(db, LAUNCHER_KEYS.defaultTerminal, TERMINAL_APP_TERMINAL);
  const selected = getSetting<unknown>(db, LAUNCHER_KEYS.selectedProjectId, null);
  return {
    shortcut: shortcut === null ? null : isValidAccelerator(shortcut) ? shortcut : DEFAULT_SHORTCUT,
    defaultTerminal: typeof terminal === "string" && isValidTerminalChoice(terminal) && terminal !== "default" ? terminal : TERMINAL_APP_TERMINAL,
    selectedProjectId: typeof selected === "number" && Number.isSafeInteger(selected) && selected > 0 ? selected : null
  };
};

export const writeLauncherSettings = (db: Db, patch: Partial<StoredLauncherSettings>): void => {
  if (patch.shortcut !== undefined) setSetting(db, LAUNCHER_KEYS.shortcut, patch.shortcut);
  if (patch.defaultTerminal !== undefined) setSetting(db, LAUNCHER_KEYS.defaultTerminal, patch.defaultTerminal);
  if (patch.selectedProjectId !== undefined) setSetting(db, LAUNCHER_KEYS.selectedProjectId, patch.selectedProjectId);
};
