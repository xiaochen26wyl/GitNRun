import { basename, normalize } from "node:path";
import type { DocumentShortcut, DocumentShortcutInput, DocumentOpener } from "@shared/documents";
import { MAX_DOCUMENT_SHORTCUTS, validateDocumentShortcutInput } from "@shared/documents";
import type { Db } from "@main/db/database";
import { getSetting, setSetting } from "@main/db/settings-repo";
import { UserFacingError } from "@main/errors";

export const DOCUMENT_SHORTCUTS_KEY = "documents.shortcuts";

export interface DocumentHandlersDeps {
  db: Db;
  discoverReadmes?: () => DocumentShortcut[];
  inspect: (path: string) => Promise<"dir" | "file" | "missing">;
  open: (path: string, opener: DocumentOpener, kind: "dir" | "file") => Promise<{ ok: true } | { ok: false; message: string }>;
  now: () => number;
  onConfigChanged: () => void;
}

export interface DocumentHandlers {
  list(): DocumentShortcut[];
  save(input: DocumentShortcutInput): DocumentShortcut;
  remove(id: number): void;
  open(id: number): Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isShortcut = (value: unknown): value is DocumentShortcut => {
  if (!isRecord(value)) {
    return false;
  }
  const { id, label, path, opener, createdAt, updatedAt } = value;
  return (
    typeof id === "number" &&
    Number.isSafeInteger(id) &&
    id > 0 &&
    typeof label === "string" &&
    typeof path === "string" &&
    path.startsWith("/") &&
    ["default", "finder", "cursor", "vscode", "textedit"].includes(String(opener)) &&
    typeof createdAt === "number" &&
    Number.isSafeInteger(createdAt) &&
    typeof updatedAt === "number" &&
    Number.isSafeInteger(updatedAt)
  );
};

const readShortcuts = (db: Db): DocumentShortcut[] => {
  const stored = getSetting<unknown>(db, DOCUMENT_SHORTCUTS_KEY, []);
  return Array.isArray(stored) ? stored.filter(isShortcut).slice(0, MAX_DOCUMENT_SHORTCUTS) : [];
};

const writeShortcuts = (db: Db, shortcuts: DocumentShortcut[]): void => {
  setSetting(db, DOCUMENT_SHORTCUTS_KEY, shortcuts.slice(0, MAX_DOCUMENT_SHORTCUTS));
};

const normalizeShortcutPath = (path: string): string => normalize(path);

const withDiscoveredReadmes = (saved: DocumentShortcut[], discovered: DocumentShortcut[]): DocumentShortcut[] => {
  const seen = new Set(saved.map((shortcut) => shortcut.path));
  const result = [...saved];
  for (const shortcut of discovered) {
    if (seen.has(shortcut.path)) {
      continue;
    }
    seen.add(shortcut.path);
    result.push(shortcut);
  }
  return result;
};

export const createDocumentHandlers = (deps: DocumentHandlersDeps): DocumentHandlers => {
  const { db } = deps;

  const requireShortcut = (id: number): DocumentShortcut => {
    const saved = readShortcuts(db);
    const shortcut = saved.find((item) => item.id === id) ?? deps.discoverReadmes?.().find((item) => item.id === id);
    if (!shortcut) {
      throw new UserFacingError("找不到這個文件捷徑");
    }
    return shortcut;
  };

  return {
    list: () => withDiscoveredReadmes(readShortcuts(db), deps.discoverReadmes?.() ?? []),

    save(input) {
      const validation = validateDocumentShortcutInput(input);
      if (!validation.ok) {
        throw new UserFacingError(validation.errors.join("、"));
      }
      const now = deps.now();
      const current = readShortcuts(db);
      const path = normalizeShortcutPath(validation.value.path);
      const existing = validation.value.id > 0 ? current.find((item) => item.id === validation.value.id) : undefined;
      const duplicate = current.find((item) => item.path === path && item.id !== validation.value.id);
      if (duplicate && validation.value.id === 0) {
        return duplicate;
      }
      if (!existing && current.length >= MAX_DOCUMENT_SHORTCUTS) {
        throw new UserFacingError("文件捷徑已達上限");
      }

      const saved: DocumentShortcut = {
        id: existing?.id ?? current.reduce((max, item) => Math.max(max, item.id), 0) + 1,
        label: validation.value.label || basename(path) || path,
        path,
        opener: validation.value.opener,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      const next = existing ? current.map((item) => (item.id === saved.id ? saved : item)) : [...current, saved];
      writeShortcuts(db, next);
      deps.onConfigChanged();
      return saved;
    },

    remove(id) {
      const current = readShortcuts(db);
      const next = current.filter((item) => item.id !== id);
      if (next.length !== current.length) {
        writeShortcuts(db, next);
        deps.onConfigChanged();
      }
    },

    async open(id) {
      const shortcut = requireShortcut(id);
      const kind = await deps.inspect(shortcut.path);
      if (kind === "missing") {
        throw new UserFacingError("找不到這個路徑");
      }
      const result = await deps.open(shortcut.path, shortcut.opener, kind);
      if (!result.ok) {
        throw new UserFacingError(result.message);
      }
    }
  };
};
