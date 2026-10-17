import { join } from "node:path";
import type { InstallManager } from "@shared/run";
import { nodeManifestFs, type ManifestFs } from "@main/run/manifest";

/**
 * 重裝依賴要用哪個套件管理員：package.json 的 packageManager 欄位優先，其次 lock 檔。
 * 兩者都沒有時沿用 inherited（monorepo 子資料夾沿用根目錄的），再沒有才用 npm。
 */

const DECLARED = /^(pnpm|yarn|bun|npm)@/;
const LOCK_FILES: ReadonlyArray<readonly [string, InstallManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["package-lock.json", "npm"]
];

const declaredManager = async (dir: string, fs: Pick<ManifestFs, "lstat" | "readFile">): Promise<InstallManager | null> => {
  const file = join(dir, "package.json");
  if ((await fs.lstat(file)) === null) return null;
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file));
    const declared = typeof parsed === "object" && parsed !== null ? (parsed as { packageManager?: unknown }).packageManager : undefined;
    const match = typeof declared === "string" ? DECLARED.exec(declared) : null;
    return match === null ? null : (match[1] as InstallManager);
  } catch {
    return null;
  }
};

export const detectInstaller = async (
  dir: string,
  inherited: InstallManager | null,
  fs: Pick<ManifestFs, "lstat" | "readFile"> = nodeManifestFs
): Promise<InstallManager> => {
  const declared = await declaredManager(dir, fs);
  if (declared !== null) return declared;
  for (const [file, manager] of LOCK_FILES) {
    if ((await fs.lstat(join(dir, file))) !== null) return manager;
  }
  return inherited ?? "npm";
};
