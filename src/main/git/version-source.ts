import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { VersionSource } from "@shared/branch-template";
import type { GitRunner } from "@main/git/run-git";

/**
 * 讀專案版本。檔名固定（package.json／VERSION），不接受使用者指定的路徑，
 * 所以不可能被拿來讀專案目錄以外的檔案。
 */

const MAX_VERSION_FILE_BYTES = 1024 * 1024;

export type ReadTextFile = (path: string) => Promise<string>;

const defaultReadTextFile: ReadTextFile = async (path) => {
  const text = await readFile(path, "utf8");
  if (text.length > MAX_VERSION_FILE_BYTES) {
    throw new Error("file too large");
  }
  return text;
};

export interface ReadVersionOptions {
  localPath: string;
  source: VersionSource;
  runGit: GitRunner;
  readTextFile?: ReadTextFile;
}

/** 回傳原始版本字串（尚未正規化）；讀不到就回傳 null。 */
export const readProjectVersion = async (options: ReadVersionOptions): Promise<string | null> => {
  const read = options.readTextFile ?? defaultReadTextFile;
  try {
    switch (options.source) {
      case "package.json": {
        const parsed: unknown = JSON.parse(await read(join(options.localPath, "package.json")));
        const version = typeof parsed === "object" && parsed !== null ? (parsed as { version?: unknown }).version : undefined;
        return typeof version === "string" && version.length > 0 ? version : null;
      }
      case "VERSION": {
        const firstLine = (await read(join(options.localPath, "VERSION"))).split("\n", 1)[0]?.trim();
        return firstLine ? firstLine : null;
      }
      case "git-tag": {
        const result = await options.runGit(options.localPath, ["describe", "--tags", "--abbrev=0"]);
        return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : null;
      }
    }
  } catch {
    return null;
  }
};
