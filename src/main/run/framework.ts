import { basename, join } from "node:path";
import type { RunServiceSpec } from "@shared/run";
import { serviceDirectory } from "@main/run/manifest";

/** 從服務的啟動指令、package.json 與 Python 相依檔猜框架名稱，只讀檔、不執行任何東西；辨識不出來回傳 null。 */

export interface FrameworkFs {
  /** 讀不到（不存在或讀取失敗）回傳 null。 */
  readText(path: string): Promise<string | null>;
  /** 資料夾底下的子資料夾名稱；不存在回傳空陣列。 */
  listDirs(path: string): Promise<string[]>;
}

/** 指令或 script 內容裡一看就知道的執行工具；Tauri 排在 Electron 前面，兩者並存時以實際執行的為準。 */
const COMMAND_HINTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bflutter\b/, "Flutter"],
  [/\btauri\b/, "Tauri"],
  [/\belectron\b/, "Electron"],
  [/\bnext (?:dev|start|build)\b/, "Next.js"],
  [/\bnuxt\b/, "Nuxt"],
  [/\bastro\b/, "Astro"],
  [/\bexpo\b/, "Expo"],
  [/\bmanage\.py\b/, "Django"]
];

/** package.json 相依：meta framework、桌面、後端在前，通用 UI 函式庫與建置工具殿後。 */
const DEPENDENCY_HINTS: ReadonlyArray<readonly [string, string]> = [
  ["next", "Next.js"],
  ["nuxt", "Nuxt"],
  ["astro", "Astro"],
  ["@remix-run/dev", "Remix"],
  ["@sveltejs/kit", "SvelteKit"],
  ["@tauri-apps/cli", "Tauri"],
  ["electron", "Electron"],
  ["@nestjs/core", "NestJS"],
  ["hono", "Hono"],
  ["fastify", "Fastify"],
  ["express", "Express"],
  ["koa", "Koa"],
  ["react", "React"],
  ["vue", "Vue"],
  ["svelte", "Svelte"],
  ["vite", "Vite"]
];

const PYTHON_HINTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bdjango\b/, "Django"],
  [/\bfastapi\b/, "FastAPI"],
  [/\bflask\b/, "Flask"]
];

const PYTHON_FILES = ["pyproject.toml", "requirements.txt"] as const;
const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);
const WORKSPACE_DIRS = ["apps", "packages", "services"] as const;

const fromCommand = (text: string): string | null => COMMAND_HINTS.find(([pattern]) => pattern.test(text))?.[1] ?? null;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const readPackage = async (dir: string, fs: FrameworkFs): Promise<Record<string, unknown> | null> => {
  const text = await fs.readText(join(dir, "package.json"));
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const fromDependencies = (pkg: Record<string, unknown>): string | null => {
  const names = new Set([...Object.keys(isRecord(pkg.dependencies) ? pkg.dependencies : {}), ...Object.keys(isRecord(pkg.devDependencies) ? pkg.devDependencies : {})]);
  return DEPENDENCY_HINTS.find(([name]) => names.has(name))?.[1] ?? null;
};

/** `pnpm --filter=api dev`、`npm run dev`、`yarn dev` 這類指令拆成工作區篩選名稱與 script 名稱。 */
const parseScriptCommand = (command: readonly string[]): { filter: string | null; script: string | null } | null => {
  const [manager, ...args] = command;
  if (manager === undefined || !PACKAGE_MANAGERS.has(basename(manager))) return null;
  let filter: string | null = null;
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg.startsWith("--filter=")) filter = arg.slice("--filter=".length);
    else if (arg === "--filter" || arg === "-F") filter = args[(index += 1)] ?? null;
    else if (!arg.startsWith("-")) rest.push(arg);
  }
  const words = rest[0] === "run" || rest[0] === "run-script" ? rest.slice(1) : rest;
  return { filter, script: words[0] ?? null };
};

/** 在專案根目錄與 apps、packages、services 底下一層找名稱或資料夾名稱等於 filter 的套件，回傳它的資料夾。 */
const findWorkspacePackage = async (root: string, filter: string, fs: FrameworkFs): Promise<string | null> => {
  const candidates = [root];
  for (const group of WORKSPACE_DIRS) {
    for (const name of await fs.listDirs(join(root, group))) candidates.push(join(root, group, name));
  }
  for (const dir of candidates) {
    const pkg = await readPackage(dir, fs);
    if (pkg !== null && (pkg.name === filter || (dir !== root && basename(dir) === filter))) return dir;
  }
  return null;
};

const fromPython = async (dir: string, fs: FrameworkFs): Promise<string | null> => {
  for (const file of PYTHON_FILES) {
    const text = (await fs.readText(join(dir, file)))?.toLowerCase();
    const hit = text === undefined ? undefined : PYTHON_HINTS.find(([pattern]) => pattern.test(text));
    if (hit !== undefined) return hit[1];
  }
  return null;
};

export const detectFramework = async (folder: string, spec: Pick<RunServiceSpec, "cwd" | "command">, fs: FrameworkFs): Promise<string | null> => {
  const direct = fromCommand(spec.command.join(" "));
  if (direct !== null) return direct;

  const cwd = serviceDirectory(folder, spec.cwd);
  const parsed = parseScriptCommand(spec.command);
  if (parsed !== null) {
    const packageDir = parsed.filter === null ? cwd : await findWorkspacePackage(folder, parsed.filter, fs);
    const pkg = packageDir === null ? null : await readPackage(packageDir, fs);
    if (pkg !== null) {
      const scripts = isRecord(pkg.scripts) ? pkg.scripts : {};
      const body = parsed.script === null ? undefined : scripts[parsed.script];
      const fromScript = typeof body === "string" ? fromCommand(body) : null;
      if (fromScript !== null) return fromScript;
      const fromDeps = fromDependencies(pkg);
      if (fromDeps !== null) return fromDeps;
    }
  }
  return fromPython(cwd, fs);
};
