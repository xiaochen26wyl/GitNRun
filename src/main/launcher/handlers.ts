import {
  isValidAccelerator,
  isValidTerminalChoice,
  validateMappingInput,
  TERMINAL_APP_DEFAULT,
  type LaunchResult,
  type LauncherSettings,
  type TerminalAvailability,
  type TerminalMapping
} from "@shared/launcher";
import type { Db } from "@main/db/database";
import { deleteMapping, listMappings, saveMapping } from "@main/db/mappings-repo";
import { getProject } from "@main/db/projects-repo";
import { UserFacingError } from "@main/errors";
import type { ShortcutManager } from "@main/launcher/shortcut";
import { readLauncherSettings, writeLauncherSettings } from "@main/launcher/settings";

/** 一鍵啟動終端機的處理邏輯（與 Electron 無關，可直接測試）。 */

export interface LauncherHandlerDeps {
  db: Db;
  launch: (folder: string) => Promise<LaunchResult>;
  shortcuts: Pick<ShortcutManager, "apply" | "current">;
  availability: () => TerminalAvailability;
  /** 映射、設定變動後呼叫（觸發備份）。 */
  onConfigChanged: () => void;
}

export interface LauncherSettingsPatch {
  shortcut?: string | null;
  defaultTerminal?: string;
  selectedProjectId?: number | null;
}

export interface LauncherHandlers {
  listMappings(): TerminalMapping[];
  saveMapping(raw: unknown): TerminalMapping;
  deleteMapping(id: number): void;
  launchFolder(folder: string): Promise<LaunchResult>;
  launchProject(projectId: number): Promise<LaunchResult>;
  getSettings(): LauncherSettings;
  saveSettings(patch: LauncherSettingsPatch): LauncherSettings;
  availability(): TerminalAvailability;
}

export const createLauncherHandlers = (deps: LauncherHandlerDeps): LauncherHandlers => {
  const { db } = deps;
  const preferredDefaultTerminal = (): string => (deps.availability().iterm ? "iterm" : "terminal");

  const currentSettings = (): LauncherSettings => {
    const stored = readLauncherSettings(db, preferredDefaultTerminal());
    return {
      shortcut: stored.shortcut,
      shortcutRegistered: stored.shortcut !== null && deps.shortcuts.current() === stored.shortcut,
      defaultTerminal: stored.defaultTerminal,
      selectedProjectId: stored.selectedProjectId
    };
  };

  return {
    listMappings: () => listMappings(db),

    saveMapping(raw) {
      const validation = validateMappingInput(raw);
      if (!validation.ok) {
        throw new UserFacingError(validation.errors.join("\n"));
      }
      const saved = saveMapping(db, validation.value);
      deps.onConfigChanged();
      return saved;
    },

    deleteMapping(id) {
      if (deleteMapping(db, id)) {
        deps.onConfigChanged();
      }
    },

    launchFolder: (folder) => deps.launch(folder),

    async launchProject(projectId) {
      const project = getProject(db, projectId);
      if (!project) {
        throw new UserFacingError("找不到這個專案");
      }
      if (!project.localPath) {
        return { ok: false, reason: "missing", message: "這個專案還沒有設定本機路徑" };
      }
      return deps.launch(project.localPath);
    },

    getSettings: currentSettings,

    saveSettings(patch) {
      if (patch.defaultTerminal !== undefined && (patch.defaultTerminal === TERMINAL_APP_DEFAULT || !isValidTerminalChoice(patch.defaultTerminal))) {
        throw new UserFacingError("終端機名稱不正確");
      }
      if (patch.selectedProjectId !== undefined && patch.selectedProjectId !== null && !getProject(db, patch.selectedProjectId)) {
        throw new UserFacingError("找不到這個專案");
      }
      if (patch.shortcut !== undefined && patch.shortcut !== null && !isValidAccelerator(patch.shortcut)) {
        throw new UserFacingError("快捷鍵格式不正確，需要至少一個修飾鍵（Command、Control、Alt、Shift）加上一個按鍵，例如 CommandOrControl+Shift+T");
      }

      // 先試著註冊；被其他程式佔用就整個不存，保留原本能用的快捷鍵。
      if (patch.shortcut !== undefined && !deps.shortcuts.apply(patch.shortcut)) {
        throw new UserFacingError("這組快捷鍵已被其他程式使用，請換一組");
      }
      writeLauncherSettings(db, patch);
      deps.onConfigChanged();
      return currentSettings();
    },

    availability: () => deps.availability()
  };
};
