import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { RUN_MANIFEST_FILE, RUN_MANIFEST_MAX_BYTES, validateManifest, type RunManifest } from "@shared/run";

/** 讀取並驗證專案資料夾裡的啟動描述檔；檔案系統由外部注入，方便測試。 */

export interface ManifestFs {
  /** 不存在回傳 null。 */
  lstat(path: string): Promise<{ size: number; isFile: boolean; isSymbolicLink: boolean } | null>;
  readFile(path: string): Promise<string>;
  /** 不存在回傳 null。 */
  realpath(path: string): Promise<string | null>;
}

export const nodeManifestFs: ManifestFs = {
  async lstat(path) {
    const info = await lstat(path).catch(() => null);
    return info === null ? null : { size: info.size, isFile: info.isFile(), isSymbolicLink: info.isSymbolicLink() };
  },
  readFile: (path) => readFile(path, "utf8"),
  realpath: (path) => realpath(path).catch(() => null)
};

export type LoadedManifest =
  | { status: "missing" }
  | { status: "invalid"; errors: string[] }
  | { status: "ok"; manifest: RunManifest; hash: string };

const isInside = (root: string, candidate: string): boolean => candidate === root || candidate.startsWith(root + sep);

export const loadManifest = async (folder: string, fs: ManifestFs = nodeManifestFs): Promise<LoadedManifest> => {
  const file = join(folder, RUN_MANIFEST_FILE);
  const info = await fs.lstat(file);
  if (info === null) {
    return { status: "missing" };
  }
  if (!info.isFile && !info.isSymbolicLink) {
    return { status: "invalid", errors: [`${RUN_MANIFEST_FILE} 不是一般檔案`] };
  }
  if (info.size > RUN_MANIFEST_MAX_BYTES) {
    return { status: "invalid", errors: [`${RUN_MANIFEST_FILE} 超過 ${RUN_MANIFEST_MAX_BYTES / 1024} KB`] };
  }

  const root = await fs.realpath(folder);
  const realFile = await fs.realpath(file);
  if (root === null || realFile === null || !isInside(root, realFile)) {
    return { status: "invalid", errors: [`${RUN_MANIFEST_FILE} 不能是指向專案資料夾外的連結`] };
  }

  let raw: string;
  try {
    raw = await fs.readFile(realFile);
  } catch {
    return { status: "invalid", errors: [`讀不到 ${RUN_MANIFEST_FILE}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "invalid", errors: [`${RUN_MANIFEST_FILE} 不是合法的 JSON`] };
  }

  const validation = validateManifest(parsed);
  if (!validation.ok) {
    return { status: "invalid", errors: validation.errors };
  }

  // 工作目錄在檔案系統上的實際位置也必須在專案內（擋符號連結跳出專案）。
  const errors: string[] = [];
  for (const service of validation.manifest.services) {
    const real = await fs.realpath(resolve(root, service.cwd));
    if (real === null) errors.push(`${service.name}.cwd：找不到資料夾 ${service.cwd}`);
    else if (!isInside(root, real)) errors.push(`${service.name}.cwd：${service.cwd} 實際位置在專案資料夾外`);
  }
  if (errors.length > 0) {
    return { status: "invalid", errors };
  }

  return { status: "ok", manifest: validation.manifest, hash: createHash("sha256").update(raw).digest("hex") };
};

/** 服務工作目錄的絕對路徑（呼叫前描述檔已通過 loadManifest 的檢查）。 */
export const serviceDirectory = (folder: string, cwd: string): string => resolve(folder, cwd);
