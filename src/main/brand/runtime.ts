import { readdir, lstat, readFile, realpath } from "node:fs/promises";
import type { Db } from "@main/db/database";
import { createBrandHandlers, type BrandFs, type BrandHandlers } from "@main/brand/handlers";
import { documentTargets } from "@main/documents/runtime";

export const nodeBrandFs: BrandFs = {
  readDir: (path) => readdir(path).catch(() => null),
  async lstat(path) {
    const info = await lstat(path).catch(() => null);
    return info === null ? null : { size: info.size, isFile: info.isFile(), isSymbolicLink: info.isSymbolicLink() };
  },
  realpath: (path) => realpath(path).catch(() => null),
  readFile: (path) => readFile(path, "utf8")
};

/** 專案範圍與文件空間一致：專案清單的 localPath、專案啟動的資料夾、文件根目錄底下的 git repo。 */
export const createBrandRuntime = (deps: { db: Db }): BrandHandlers =>
  createBrandHandlers({
    listFolders: () => documentTargets(deps.db).map((target) => target.folder),
    fs: nodeBrandFs
  });
