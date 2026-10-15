import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { RUN_MANIFEST_FILE, RUN_MANIFEST_MAX_BYTES, validateManifest, type RunManifest, type RunRole } from "@shared/run";

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

const PACKAGE_JSON = "package.json";
const PUBSPEC_YAML = "pubspec.yaml";

const BACKEND_SCRIPTS = ["dev:backend", "backend:dev", "dev:api", "api:dev", "dev:server", "server:dev", "backend", "api", "server"] as const;
const FRONTEND_SCRIPTS = ["dev:frontend", "frontend:dev", "dev:web", "web:dev", "dev:client", "client:dev", "frontend", "web", "client", "dev"] as const;
const DESKTOP_SCRIPTS = ["dev:desktop", "desktop:dev", "dev:electron", "electron:dev", "desktop", "electron"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readScripts = (raw: unknown): Record<string, string> => {
  if (!isRecord(raw) || !isRecord(raw.scripts)) {
    return {};
  }
  return Object.fromEntries(Object.entries(raw.scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
};

const findScript = (scripts: Record<string, string>, candidates: readonly string[]): string | null =>
  candidates.find((script) => scripts[script] !== undefined) ?? null;

const detectPackageManager = async (folder: string, rawPackage: unknown, fs: ManifestFs): Promise<"pnpm" | "npm" | "yarn" | "bun"> => {
  const declared = isRecord(rawPackage) && typeof rawPackage.packageManager === "string" ? rawPackage.packageManager : "";
  if (declared.startsWith("pnpm@")) return "pnpm";
  if (declared.startsWith("yarn@")) return "yarn";
  if (declared.startsWith("bun@")) return "bun";
  if (declared.startsWith("npm@")) return "npm";

  if ((await fs.lstat(join(folder, "pnpm-lock.yaml"))) !== null) return "pnpm";
  if ((await fs.lstat(join(folder, "yarn.lock"))) !== null) return "yarn";
  if ((await fs.lstat(join(folder, "bun.lockb"))) !== null || (await fs.lstat(join(folder, "bun.lock"))) !== null) return "bun";
  return "npm";
};

const packageManagerCommand = (manager: "pnpm" | "npm" | "yarn" | "bun", script: string): string[] =>
  manager === "yarn" ? ["yarn", script] : [manager, "run", script];

const inferredService = ({
  name,
  role,
  script,
  manager,
  hasBackend
}: {
  name: string;
  role: RunRole;
  script: string;
  manager: "pnpm" | "npm" | "yarn" | "bun";
  hasBackend: boolean;
}) => {
  const env =
    role === "backend" || role === "frontend"
      ? {
          PORT: "{port}",
          DEV_PORT: "{port}",
          ...(role === "frontend" && hasBackend ? { API_BASE_URL: "{api.url}", VITE_API_BASE_URL: "{api.url}" } : {})
        }
      : {};
  return {
    name,
    role,
    cwd: ".",
    command: packageManagerCommand(manager, script),
    env,
    port: role !== "desktop",
    needs: role === "desktop" && hasBackend ? ["api"] : []
  };
};

const inferPackageManifest = async (folder: string, root: string, fs: ManifestFs): Promise<LoadedManifest> => {
  const file = join(folder, PACKAGE_JSON);
  const info = await fs.lstat(file);
  if (info === null) {
    return { status: "missing" };
  }
  if (!info.isFile && !info.isSymbolicLink) {
    return { status: "invalid", errors: [`${PACKAGE_JSON} 不是一般檔案`] };
  }

  const realFile = await fs.realpath(file);
  if (realFile === null || !isInside(root, realFile)) {
    return { status: "invalid", errors: [`${PACKAGE_JSON} 不能是指向專案資料夾外的連結`] };
  }

  let raw: string;
  try {
    raw = await fs.readFile(realFile);
  } catch {
    return { status: "invalid", errors: [`讀不到 ${PACKAGE_JSON}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "invalid", errors: [`${PACKAGE_JSON} 不是合法的 JSON`] };
  }

  const scripts = readScripts(parsed);
  const backendScript = findScript(scripts, BACKEND_SCRIPTS);
  const frontendScript = findScript(scripts, FRONTEND_SCRIPTS);
  const desktopScript = findScript(scripts, DESKTOP_SCRIPTS);
  if (!backendScript && !frontendScript && !desktopScript) {
    return { status: "missing" };
  }

  const manager = await detectPackageManager(folder, parsed, fs);
  const hasBackend = backendScript !== null;
  const services = [
    ...(backendScript ? [inferredService({ name: "api", role: "backend", script: backendScript, manager, hasBackend })] : []),
    ...(frontendScript && frontendScript !== backendScript ? [inferredService({ name: "web", role: "frontend", script: frontendScript, manager, hasBackend })] : []),
    ...(desktopScript && desktopScript !== backendScript && desktopScript !== frontendScript
      ? [inferredService({ name: "desktop", role: "desktop", script: desktopScript, manager, hasBackend })]
      : [])
  ];

  const validation = validateManifest({ version: 1, services });
  if (!validation.ok) {
    return { status: "invalid", errors: validation.errors };
  }
  return { status: "ok", manifest: validation.manifest, hash: createHash("sha256").update(`package:${raw}`).digest("hex") };
};

const inferFlutterManifest = async (folder: string, root: string, fs: ManifestFs): Promise<LoadedManifest> => {
  const file = join(folder, PUBSPEC_YAML);
  const info = await fs.lstat(file);
  if (info === null) {
    return { status: "missing" };
  }
  if (!info.isFile && !info.isSymbolicLink) {
    return { status: "invalid", errors: [`${PUBSPEC_YAML} 不是一般檔案`] };
  }

  const realFile = await fs.realpath(file);
  if (realFile === null || !isInside(root, realFile)) {
    return { status: "invalid", errors: [`${PUBSPEC_YAML} 不能是指向專案資料夾外的連結`] };
  }

  let raw: string;
  try {
    raw = await fs.readFile(realFile);
  } catch {
    return { status: "invalid", errors: [`讀不到 ${PUBSPEC_YAML}`] };
  }

  // iOS 模擬器與 Android 模擬器拆成兩個獨立服務：電腦不一定撐得起兩個同時跑，由使用者各自啟動。
  const validation = validateManifest({
    version: 1,
    services: [
      {
        name: "flutter",
        role: "frontend",
        cwd: ".",
        command: ["flutter", "run", "-d", "chrome", "--web-port", "{port}"],
        port: true,
        env: {}
      },
      { name: "flutter-ios", role: "desktop", cwd: ".", command: ["flutter", "run", "-d", "iPhone"], port: false, env: {} },
      { name: "flutter-android", role: "desktop", cwd: ".", command: ["flutter", "run", "-d", "emulator"], port: false, env: {} }
    ]
  });
  if (!validation.ok) {
    return { status: "invalid", errors: validation.errors };
  }
  return { status: "ok", manifest: validation.manifest, hash: createHash("sha256").update(`flutter-mobile:${raw}`).digest("hex") };
};

export const loadManifest = async (folder: string, fs: ManifestFs = nodeManifestFs): Promise<LoadedManifest> => {
  const file = join(folder, RUN_MANIFEST_FILE);
  const info = await fs.lstat(file);
  const root = await fs.realpath(folder);
  if (root === null) {
    return { status: "missing" };
  }
  if (info === null) {
    const fromPackage = await inferPackageManifest(folder, root, fs);
    return fromPackage.status === "missing" ? inferFlutterManifest(folder, root, fs) : fromPackage;
  }
  if (!info.isFile && !info.isSymbolicLink) {
    return { status: "invalid", errors: [`${RUN_MANIFEST_FILE} 不是一般檔案`] };
  }
  if (info.size > RUN_MANIFEST_MAX_BYTES) {
    return { status: "invalid", errors: [`${RUN_MANIFEST_FILE} 超過 ${RUN_MANIFEST_MAX_BYTES / 1024} KB`] };
  }

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
