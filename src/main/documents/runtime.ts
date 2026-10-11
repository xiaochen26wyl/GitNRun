import { lstatSync, readdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, join, normalize, relative } from "node:path";
import type { DocumentOpener, DocumentShortcut } from "@shared/documents";
import type { Db } from "@main/db/database";
import { listProjects } from "@main/db/projects-repo";
import { createDocumentHandlers, type DocumentHandlers } from "@main/documents/handlers";
import { redactSecrets } from "@main/log-redaction";
import { listRunFolders } from "@main/run/store";

const OPEN = "/usr/bin/open";
const ERROR_TEXT_MAX = 300;
const MAX_READMES_PER_TARGET = 50;
const MAX_SCAN_DEPTH = 5;
const MAX_SCAN_ENTRIES = 5_000;
const README_NAME = /^readme(?:\.[a-z0-9][a-z0-9._-]*)?$/i;
const SKIPPED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".nuxt",
  ".turbo",
  ".vercel",
  ".yarn",
  "coverage",
  "dist",
  "build",
  "node_modules",
  "release",
  "target",
  "vendor"
]);

const APP_NAMES: Record<Exclude<DocumentOpener, "default" | "finder">, string> = {
  cursor: "Cursor",
  vscode: "Visual Studio Code",
  textedit: "TextEdit"
};

const inspect = async (path: string): Promise<"dir" | "file" | "missing"> => {
  const info = await stat(path).catch(() => null);
  return info === null ? "missing" : info.isDirectory() ? "dir" : "file";
};

const runOpen = (args: readonly string[]): Promise<{ code: number; stderr: string }> =>
  new Promise((resolve) => {
    execFile(OPEN, [...args], { windowsHide: true }, (error, _stdout, stderr) => {
      resolve({ code: error ? 1 : 0, stderr: stderr ?? "" });
    });
  });

const openPath = async (
  path: string,
  opener: DocumentOpener,
  kind: "dir" | "file"
): Promise<{ ok: true } | { ok: false; message: string }> => {
  const args =
    opener === "default"
      ? [path]
      : opener === "finder"
        ? kind === "dir"
          ? [path]
          : ["-R", path]
        : ["-a", APP_NAMES[opener], path];
  const result = await runOpen(args);
  if (result.code === 0) {
    return { ok: true };
  }
  return { ok: false, message: `無法開啟路徑：${redactSecrets(result.stderr.trim()).slice(0, ERROR_TEXT_MAX) || "未知錯誤"}` };
};

interface DocumentTarget {
  label: string;
  folder: string;
}

const readmeLabel = (target: DocumentTarget, path: string): string => {
  const rel = relative(target.folder, path);
  return `${target.label} · ${rel && !rel.startsWith("..") ? rel : basename(path)}`;
};

const findReadmes = (folder: string): string[] => {
  try {
    if (!lstatSync(folder).isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  const found: string[] = [];
  let scanned = 0;
  const walk = (dir: string, depth: number): void => {
    if (found.length >= MAX_READMES_PER_TARGET || scanned >= MAX_SCAN_ENTRIES) {
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    scanned += entries.length;

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= MAX_READMES_PER_TARGET) {
        return;
      }
      if (entry.isFile() && README_NAME.test(entry.name)) {
        found.push(join(dir, entry.name));
      }
    }
    if (depth >= MAX_SCAN_DEPTH) {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || SKIPPED_DIRS.has(entry.name)) {
        continue;
      }
      walk(join(dir, entry.name), depth + 1);
    }
  };

  walk(folder, 0);
  return found;
};

const documentTargets = (db: Db): DocumentTarget[] => {
  const seen = new Set<string>();
  const targets: DocumentTarget[] = [];
  for (const project of listProjects(db)) {
    if (!project.localPath) {
      continue;
    }
    const folder = normalize(project.localPath);
    if (seen.has(folder)) {
      continue;
    }
    seen.add(folder);
    targets.push({ label: project.name, folder });
  }
  for (const entry of listRunFolders(db)) {
    const folder = normalize(entry.path);
    if (seen.has(folder)) {
      continue;
    }
    seen.add(folder);
    targets.push({ label: basename(folder) || folder, folder });
  }
  return targets;
};

const discoverReadmes = (db: Db): DocumentShortcut[] => {
  const shortcuts: DocumentShortcut[] = [];
  let id = -1;
  for (const target of documentTargets(db)) {
    for (const path of findReadmes(target.folder)) {
      shortcuts.push({
        id,
        label: readmeLabel(target, path),
        path,
        opener: "default",
        source: "project-readme",
        createdAt: 0,
        updatedAt: 0
      });
      id -= 1;
    }
  }
  return shortcuts;
};

export const createDocumentRuntime = (deps: { db: Db; now: () => number; onConfigChanged: () => void }): DocumentHandlers =>
  createDocumentHandlers({
    db: deps.db,
    discoverReadmes: () => discoverReadmes(deps.db),
    inspect,
    open: openPath,
    now: deps.now,
    onConfigChanged: deps.onConfigChanged
  });
