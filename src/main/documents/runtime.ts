import { existsSync, lstatSync, readdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, join, normalize } from "node:path";
import { DEFAULT_DOCUMENT_OPENER, type DocumentOpener, type DocumentShortcut } from "@shared/documents";
import type { Db } from "@main/db/database";
import { listProjects } from "@main/db/projects-repo";
import { createDocumentHandlers, readDocumentRoot, type DocumentHandlers } from "@main/documents/handlers";
import { redactSecrets } from "@main/log-redaction";
import { listRunFolders } from "@main/run/store";

const OPEN = "/usr/bin/open";
const ERROR_TEXT_MAX = 300;
const MAX_ROOT_REPOS = 200;
const README_NAME = /^readme\.md$/i;

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

export const openPath = async (
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

export interface DocumentTarget {
  label: string;
  folder: string;
}

/** 只取專案根目錄的 README.md；子資料夾的、README.ja.md 這類其他檔名一律不收。 */
export const findReadme = (folder: string): string | null => {
  try {
    if (!lstatSync(folder).isDirectory()) {
      return null;
    }
    const entry = readdirSync(folder, { withFileTypes: true }).find((item) => item.isFile() && README_NAME.test(item.name));
    return entry ? join(folder, entry.name) : null;
  } catch {
    return null;
  }
};

/** 專案根目錄底下第一層、含 .git 的資料夾（worktree 的 .git 是檔案，一樣算）。 */
export const findRepoFolders = (root: string): string[] => {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => join(root, entry.name))
    .filter((folder) => existsSync(join(folder, ".git")))
    .slice(0, MAX_ROOT_REPOS);
};

export const documentTargets = (db: Db): DocumentTarget[] => {
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
  const root = readDocumentRoot(db);
  for (const repoFolder of root === "" ? [] : findRepoFolders(root)) {
    const folder = normalize(repoFolder);
    if (seen.has(folder)) {
      continue;
    }
    seen.add(folder);
    targets.push({ label: basename(folder), folder });
  }
  return targets;
};

export const discoverReadmes = (db: Db): DocumentShortcut[] => {
  const shortcuts: DocumentShortcut[] = [];
  let id = -1;
  for (const target of documentTargets(db)) {
    const path = findReadme(target.folder);
    if (path === null) {
      continue;
    }
    shortcuts.push({
      id,
      label: `${target.label} · README.md`,
      path,
      opener: DEFAULT_DOCUMENT_OPENER,
      source: "project-readme",
      createdAt: 0,
      updatedAt: 0
    });
    id -= 1;
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
