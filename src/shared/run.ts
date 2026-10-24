import type { SecretStatus } from "@shared/secrets";

/**
 * 專案啟動描述檔（`.gitnrun/run.json`）的型別、驗證、佔位展開、命令列與啟動計畫（純函式）。
 *
 * 描述檔來自專案資料夾，內容會隨 git pull 改變，所以一律當成不可信輸入：
 * 驗證全部 fail-closed，命令列由這裡產生並逐段引用，不經過任何字串拼接成 script 的流程。
 */

export const RUN_MANIFEST_FILE = ".gitnrun/run.json";
export const RUN_MANIFEST_VERSION = 1;
export const RUN_MANIFEST_MAX_BYTES = 64 * 1024;

export const RUN_ROLES = ["backend", "frontend", "desktop"] as const;
export type RunRole = (typeof RUN_ROLES)[number];

export const RUN_PROJECT_ACTIONS = ["readme", "reinstall", "start-backend", "release-backend", "release-all"] as const;
export const RUN_SERVICE_ACTIONS = ["start", "web", "release"] as const;
export type RunProjectActionName = (typeof RUN_PROJECT_ACTIONS)[number];
export type RunServiceActionName = (typeof RUN_SERVICE_ACTIONS)[number];
export type RunAction =
  | { scope: "project"; action: RunProjectActionName }
  | { scope: "service"; service: string; action: RunServiceActionName };

export const MAX_SERVICES = 20;
export const MAX_COMMAND_ARGS = 40;
export const MAX_ARG_LENGTH = 500;
export const MAX_ENV_ENTRIES = 20;
export const MAX_NEEDS = 8;
export const MAX_CWD_LENGTH = 200;

export interface RunServiceSpec {
  name: string;
  role: RunRole;
  /** 相對專案資料夾的工作目錄（已正規化，不含 .. 與開頭斜線）。 */
  cwd: string;
  /** 程式加參數；每一項都會被單獨引用，不經過 shell 解析。 */
  command: string[];
  env: Record<string, string>;
  /** 是否需要 gitnrun 分配 port（前端必須為 true；後端的背景 worker／排程可為 false）。 */
  port: boolean;
  /** 本機固定 port；省略時仍由 GitNRun 動態配置。 */
  fixedPort?: number;
  needs: string[];
}

export interface RunManifest {
  version: typeof RUN_MANIFEST_VERSION;
  services: RunServiceSpec[];
}

export type ManifestValidation = { ok: true; manifest: RunManifest } | { ok: false; errors: string[] };

// ---------------------------------------------------------------------------
// 驗證
// ---------------------------------------------------------------------------

const CONTROL = /[\u0000-\u001f\u007f]/;
const SERVICE_NAME = /^[a-z][a-z0-9-]{0,29}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

export const isRunServiceName = (value: unknown): value is string => typeof value === "string" && SERVICE_NAME.test(value);

/** 會改變行程載入行為或 shell 啟動行為的變數，描述檔不得設定。 */
const FORBIDDEN_ENV = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "NODE_OPTIONS",
  "NODE_PATH",
  "ELECTRON_RUN_AS_NODE",
  "BASH_ENV",
  "ENV",
  "ZDOTDIR",
  "IFS",
  "PS4",
  "PROMPT_COMMAND",
  "PYTHONPATH",
  "PYTHONSTARTUP"
]);

export const isForbiddenEnvName = (name: string): boolean =>
  FORBIDDEN_ENV.has(name) || name.startsWith("LD_") || name.startsWith("DYLD_") || name.startsWith("GITNRUN_SIDECAR_");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const SERVICE_KEYS = ["name", "role", "cwd", "command", "env", "port", "fixedPort", "needs"] as const;

/** 回傳不在允許清單內的欄位名稱（依物件內的順序）。 */
const unknownKeys = (value: Record<string, unknown>, allowed: readonly string[]): string[] =>
  Object.keys(value).filter((key) => !allowed.includes(key));

/** 一次列出所有多餘欄位；底線開頭通常是範例檔的註解，多加一句提醒刪除。 */
const unknownKeysMessage = (prefix: string, keys: readonly string[], allowed: readonly string[]): string => {
  const hint = keys.some((key) => key.startsWith("_")) ? "；底線開頭的註解欄位請刪除" : "";
  return `${prefix}：有不認得的欄位 ${keys.join("、")}（只允許 ${allowed.join("、")}${hint}）`;
};

/** 服務標籤：名稱合法時帶上服務名稱，讓錯誤能對到描述檔裡的哪一個服務。 */
const serviceLabel = (raw: unknown, index: number): string => {
  const name = isRecord(raw) && typeof raw.name === "string" && SERVICE_NAME.test(raw.name) ? raw.name : null;
  return name === null ? `services[${index}]` : `services[${index}]（${name}）`;
};

/** 每次呼叫都建新的 RegExp，避免全域旗標的 lastIndex 狀態在呼叫間殘留。 */
const placeholderRegex = (): RegExp => /\{(?:([a-z][a-z0-9-]{0,29})\.)?(port|url)\}/g;

interface PlaceholderRef {
  /** null = 服務自己。 */
  service: string | null;
  kind: "port" | "url";
}

const findPlaceholders = (text: string): PlaceholderRef[] =>
  [...text.matchAll(placeholderRegex())].map((match) => ({ service: match[1] ?? null, kind: match[2] === "url" ? "url" : "port" }));

/** 去掉合法佔位後還有大括號 = 打錯的佔位（例如 {prot}），一律視為錯誤。 */
const hasStrayBraces = (text: string): boolean => /[{}]/.test(text.replace(placeholderRegex(), ""));

const normalizeCwd = (raw: string): string | null => {
  if (raw.length === 0 || raw.length > MAX_CWD_LENGTH || CONTROL.test(raw) || raw.startsWith("/")) {
    return null;
  }
  const segments = raw.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) {
    return null;
  }
  return segments.length === 0 ? "." : segments.join("/");
};

const parseService = (raw: unknown, index: number, errors: string[]): RunServiceSpec | null => {
  const label = serviceLabel(raw, index);
  const before = errors.length;
  if (!isRecord(raw)) {
    errors.push(`${label}：需要是物件`);
    return null;
  }
  const extra = unknownKeys(raw, SERVICE_KEYS);
  if (extra.length > 0) {
    errors.push(unknownKeysMessage(label, extra, SERVICE_KEYS));
  }

  const name = typeof raw.name === "string" && SERVICE_NAME.test(raw.name) ? raw.name : null;
  if (name === null) {
    errors.push(`${label}.name：只能用小寫英文、數字與 -，且以英文字母開頭（最長 30 字）`);
  }

  const role = RUN_ROLES.find((candidate) => candidate === raw.role) ?? null;
  if (role === null) {
    errors.push(`${label}.role：需為 ${RUN_ROLES.join("、")} 其中之一`);
  }

  const cwd = raw.cwd === undefined ? "." : typeof raw.cwd === "string" ? normalizeCwd(raw.cwd) : null;
  if (cwd === null) {
    errors.push(`${label}.cwd：需為專案資料夾內的相對路徑（不可為絕對路徑或含 ..）`);
  }

  let command: string[] = [];
  if (!Array.isArray(raw.command) || raw.command.length === 0 || raw.command.length > MAX_COMMAND_ARGS) {
    errors.push(`${label}.command：需為 1～${MAX_COMMAND_ARGS} 個字串的陣列`);
  } else if (raw.command.some((arg) => typeof arg !== "string" || arg.length > MAX_ARG_LENGTH || CONTROL.test(arg))) {
    errors.push(`${label}.command：每一項都需為不含控制字元的字串（最長 ${MAX_ARG_LENGTH} 字）`);
  } else {
    command = raw.command as string[];
    const program = command[0] ?? "";
    if (program.length === 0 || program.startsWith("-")) {
      errors.push(`${label}.command[0]：程式名稱不可為空，也不可以 - 開頭`);
    }
  }

  const env: Record<string, string> = {};
  if (raw.env !== undefined) {
    if (!isRecord(raw.env) || Object.keys(raw.env).length > MAX_ENV_ENTRIES) {
      errors.push(`${label}.env：需為最多 ${MAX_ENV_ENTRIES} 項的物件`);
    } else {
      for (const [key, value] of Object.entries(raw.env)) {
        if (!ENV_NAME.test(key)) {
          errors.push(`${label}.env.${key}：變數名稱只能用大寫英文、數字與底線`);
        } else if (isForbiddenEnvName(key)) {
          errors.push(`${label}.env.${key}：這個變數會改變行程載入行為，不能由描述檔設定`);
        } else if (typeof value !== "string" || value.length > MAX_ARG_LENGTH || CONTROL.test(value)) {
          errors.push(`${label}.env.${key}：值需為不含控制字元的字串（最長 ${MAX_ARG_LENGTH} 字）`);
        } else {
          env[key] = value;
        }
      }
    }
  }

  const port = raw.port === undefined ? false : raw.port;
  if (typeof port !== "boolean") {
    errors.push(`${label}.port：需為 true 或 false`);
  }
  if (role === "frontend" && port !== true) {
    errors.push(`${label}.port：前端必須為 true（狀態偵測與開網頁都依賴 port）`);
  }
  const fixedPort = raw.fixedPort;
  if (fixedPort !== undefined && (typeof fixedPort !== "number" || !Number.isInteger(fixedPort) || fixedPort < 1024 || fixedPort > 65535)) {
    errors.push(`${label}.fixedPort：需為 1024～65535 的整數`);
  }
  if (fixedPort !== undefined && port !== true) {
    errors.push(`${label}.fixedPort：只能用於 port: true 的服務`);
  }

  let needs: string[] = [];
  if (raw.needs !== undefined) {
    if (!Array.isArray(raw.needs) || raw.needs.length > MAX_NEEDS || raw.needs.some((item) => typeof item !== "string" || !SERVICE_NAME.test(item))) {
      errors.push(`${label}.needs：需為最多 ${MAX_NEEDS} 個服務名稱的陣列`);
    } else {
      needs = [...new Set(raw.needs as string[])];
    }
  }

  if (errors.length > before || name === null || role === null || cwd === null || typeof port !== "boolean") {
    return null;
  }
  return { name, role, cwd, command, env, port, ...(fixedPort === undefined ? {} : { fixedPort: fixedPort as number }), needs };
};

const findNeedsCycle = (services: readonly RunServiceSpec[]): string | null => {
  const byName = new Map(services.map((service) => [service.name, service]));
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string): string | null => {
    const current = state.get(name);
    if (current === "done") return null;
    if (current === "visiting") return name;
    state.set(name, "visiting");
    for (const dep of byName.get(name)?.needs ?? []) {
      const hit = visit(dep);
      if (hit !== null) return hit;
    }
    state.set(name, "done");
    return null;
  };
  for (const service of services) {
    const hit = visit(service.name);
    if (hit !== null) return hit;
  }
  return null;
};

export const validateManifest = (raw: unknown): ManifestValidation => {
  const errors: string[] = [];
  if (!isRecord(raw)) {
    return { ok: false, errors: ["描述檔需要是 JSON 物件"] };
  }
  const extra = unknownKeys(raw, ["version", "services"]);
  if (extra.length > 0) {
    errors.push(unknownKeysMessage("最上層", extra, ["version", "services"]));
  }
  if (raw.version !== RUN_MANIFEST_VERSION) {
    errors.push(`version：目前只支援 ${RUN_MANIFEST_VERSION}`);
  }
  if (!Array.isArray(raw.services) || raw.services.length === 0 || raw.services.length > MAX_SERVICES) {
    errors.push(`services：需為 1～${MAX_SERVICES} 個服務的陣列`);
    return { ok: false, errors };
  }

  const services: RunServiceSpec[] = [];
  raw.services.forEach((item, index) => {
    const parsed = parseService(item, index, errors);
    if (parsed) services.push(parsed);
  });
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const byName = new Map<string, RunServiceSpec>();
  const byFixedPort = new Map<number, string>();
  for (const service of services) {
    if (byName.has(service.name)) {
      errors.push(`服務名稱重複：${service.name}`);
    }
    byName.set(service.name, service);
    if (service.fixedPort !== undefined) {
      const other = byFixedPort.get(service.fixedPort);
      if (other !== undefined) errors.push(`固定 port ${service.fixedPort} 重複：${other}、${service.name}`);
      byFixedPort.set(service.fixedPort, service.name);
    }
  }

  for (const service of services) {
    for (const dep of service.needs) {
      if (dep === service.name) errors.push(`${service.name}.needs：不能依賴自己`);
      else if (!byName.has(dep)) errors.push(`${service.name}.needs：找不到服務 ${dep}`);
    }

    const texts = [...service.command, ...Object.values(service.env)];
    for (const text of texts) {
      if (hasStrayBraces(text)) {
        errors.push(`${service.name}：「${text.slice(0, 40)}」含有不合法的 { }，佔位只能是 {port}、{url}、{服務.port}、{服務.url}`);
      }
      for (const ref of findPlaceholders(text)) {
        const target = ref.service === null ? service : byName.get(ref.service);
        if (!target) errors.push(`${service.name}：佔位指向不存在的服務 ${ref.service ?? ""}`);
        else if (!target.port) errors.push(`${service.name}：佔位指向沒有 port 的服務 ${target.name}`);
      }
    }
  }

  const cycle = findNeedsCycle(services);
  if (cycle !== null) {
    errors.push(`needs 有循環依賴（經過 ${cycle}）`);
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, manifest: { version: RUN_MANIFEST_VERSION, services } };
};

// ---------------------------------------------------------------------------
// 佔位展開與命令列
// ---------------------------------------------------------------------------

export const urlForPort = (port: number): string => `http://localhost:${port}`;

export const expandPlaceholders = (text: string, selfName: string, ports: Readonly<Record<string, number>>): string =>
  text.replace(placeholderRegex(), (_match, service: string | undefined, kind: string) => {
    const target = service ?? selfName;
    const port = ports[target];
    if (port === undefined) {
      throw new Error(`沒有為 ${target} 配置 port`);
    }
    return kind === "url" ? urlForPort(port) : String(port);
  });

const SAFE_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** POSIX 單引號引用：單引號本身寫成 '\''。看起來安全的字串維持原樣，讓終端機裡的指令好讀。 */
export const shellQuote = (value: string): string =>
  SAFE_TOKEN.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

/** `env K=V ... 程式 參數...`；用 env 開頭，zsh、bash、fish 都能執行。 */
export const buildCommandLine = (command: readonly string[], env: Readonly<Record<string, string>>): string => {
  const assignments = Object.entries(env).map(([key, value]) => shellQuote(`${key}=${value}`));
  const parts = [...(assignments.length > 0 ? ["env", ...assignments] : []), ...command.map(shellQuote)];
  return parts.join(" ");
};

/** 畫面上顯示用：保留佔位原樣、不引用，讓人看得懂將執行什麼。 */
export const describeCommand = (spec: Pick<RunServiceSpec, "command" | "env">): string =>
  [...Object.entries(spec.env).map(([key, value]) => `${key}=${value}`), ...spec.command].join(" ");

// ---------------------------------------------------------------------------
// 啟動計畫
// ---------------------------------------------------------------------------

const ROLE_RANK: Record<RunRole, number> = { backend: 0, frontend: 1, desktop: 2 };

/** backend：只選同專案所有後端（後端群組列的整組動作），不連帶前端與桌面版。 */
export type RunStartSelection = "all" | "desktop" | "backend" | { service: string };

/** 動作要啟動的服務（含前置服務），後端在前、前端其次、桌面最後，前置服務一定排在依賴它的服務之前。 */
export const selectServices = (manifest: RunManifest, selection: RunStartSelection): RunServiceSpec[] => {
  const byName = new Map(manifest.services.map((service) => [service.name, service]));
  const backends = manifest.services.filter((service) => service.role === "backend").map((service) => service.name);
  // 前端與桌面版一律隱含依賴同專案的所有後端，不必在描述檔手寫 needs。
  const depsOf = (service: RunServiceSpec): string[] =>
    service.role === "backend" ? service.needs : [...new Set([...service.needs, ...backends])];
  const wanted = new Set<string>();
  const add = (name: string): void => {
    if (wanted.has(name)) return;
    const service = byName.get(name);
    if (service === undefined) return;
    wanted.add(name);
    for (const dep of depsOf(service)) add(dep);
  };
  if (typeof selection === "object") {
    add(selection.service);
  } else {
    for (const service of manifest.services) {
      const picked = selection === "all" ? service.role !== "desktop" : selection === "backend" ? service.role === "backend" : service.role === "desktop";
      if (picked) add(service.name);
    }
  }

  const sorted = manifest.services
    .map((service, index) => ({ service, index }))
    .filter(({ service }) => wanted.has(service.name))
    .sort((a, b) => ROLE_RANK[a.service.role] - ROLE_RANK[b.service.role] || a.index - b.index)
    .map(({ service }) => service);

  const ordered: RunServiceSpec[] = [];
  const visited = new Set<string>();
  const visit = (service: RunServiceSpec): void => {
    if (visited.has(service.name)) return;
    visited.add(service.name);
    for (const dep of depsOf(service)) {
      const target = byName.get(dep);
      if (target) visit(target);
    }
    ordered.push(service);
  };
  sorted.forEach(visit);
  return ordered;
};

/** 需要向作業系統新要的 port 數量：有 port 需求、且沒有可沿用 port 的服務。 */
export const countFreshPorts = (manifest: RunManifest, reuse: Readonly<Record<string, number>>): number =>
  manifest.services.filter((service) => service.port && service.fixedPort === undefined && reuse[service.name] === undefined).length;

export interface RunStartItem {
  name: string;
  role: RunRole;
  cwd: string;
  commandLine: string;
  port: number | null;
}

export interface RunStartPlan {
  /** 整份描述檔所有需要 port 的服務的配置（沿用的與新配的）。 */
  ports: Record<string, number>;
  starts: RunStartItem[];
}

/**
 * @param reuse 可沿用的 port（服務已在執行或正在啟動）
 * @param skip 不需要再啟動的服務
 * @param fresh 新配置的 port，數量需為 countFreshPorts
 */
export const planStart = (
  manifest: RunManifest,
  selection: RunStartSelection,
  reuse: Readonly<Record<string, number>>,
  skip: ReadonlySet<string>,
  fresh: readonly number[]
): RunStartPlan => {
  const queue = [...fresh];
  const ports: Record<string, number> = {};
  for (const service of manifest.services) {
    if (!service.port) continue;
    const existing = reuse[service.name];
    const assigned = service.fixedPort ?? existing ?? queue.shift();
    if (assigned === undefined) {
      throw new Error("新配置的 port 數量不足");
    }
    ports[service.name] = assigned;
  }

  const starts = selectServices(manifest, selection)
    .filter((service) => !skip.has(service.name))
    .map((service): RunStartItem => {
      const command = service.command.map((arg) => expandPlaceholders(arg, service.name, ports));
      const env = Object.fromEntries(Object.entries(service.env).map(([key, value]) => [key, expandPlaceholders(value, service.name, ports)]));
      return { name: service.name, role: service.role, cwd: service.cwd, commandLine: buildCommandLine(command, env), port: ports[service.name] ?? null };
    });

  return { ports, starts };
};

// ---------------------------------------------------------------------------
// 畫面用的檢視型別與按鈕狀態
// ---------------------------------------------------------------------------

export type RunServiceState = "running" | "starting" | "stopped";
export type RunManifestStatus = "ok" | "missing" | "invalid";

export interface RunButtonState {
  enabled: boolean;
  /** 不可按時的原因；可按時為 null。 */
  reason: string | null;
}

export interface RunButtons {
  all: RunButtonState;
  web: RunButtonState;
  desktop: RunButtonState;
}

export interface RunServiceButtons {
  start: RunButtonState;
  web: RunButtonState;
  /** 釋放這個服務的 port 與殘留程序；不要求目前正在執行。 */
  release: RunButtonState;
}

export interface RunServiceView {
  name: string;
  role: RunRole;
  port: number | null;
  fixedPort: number | null;
  url: string | null;
  state: RunServiceState;
  /** 沒有 port 的服務啟動後程序立即消失（例如被單一實例鎖擋掉）；只在確實偵測到時才有值。 */
  exitedEarly?: boolean;
  /** 唯讀顯示用的指令（佔位保持原樣）。 */
  command: string;
  /** 偵測到的框架名稱（Django、Next.js…）；辨識不出來為 null，畫面退回角色標籤。 */
  framework: string | null;
  buttons: RunServiceButtons;
}

export interface RunTargetView {
  id: string;
  label: string;
  folder: string;
  source: "project" | "folder" | "discovered";
  /** 複製路徑時要不要警示：只有 source 為 "project" 才有值，取自專案上次新增／編輯時的檢查結果。 */
  pathExists?: boolean;
  manifest: RunManifestStatus;
  errors: string[];
  /** 目前的描述檔內容是否已被你確認過。 */
  trusted: boolean;
  services: RunServiceView[];
  buttons: RunButtons;
  /** 專案根目錄的 README.md 能不能開；找不到時 reason 說明原因。路徑留在主程序，不交給畫面。 */
  readme: RunButtonState;
  /** 刪除 node_modules 並重裝依賴；不是 Node 專案、服務還在跑、沒有 iTerm2 時不可按。 */
  reinstall: RunButtonState;
  /** dev 通關帳號；沒設定為空字串。帳號不是密鑰，可以完整交給畫面。 */
  account: string;
  /** 舊版存在密鑰保險庫的 Debug 密碼；已不再使用，只用來提示並讓你清除。 */
  legacyPasscode: SecretStatus;
  /** Debug 密碼的來源（專案環境檔裡的某個鍵）；明文永遠不離開主程序。 */
  passcodeSource: PasscodeSourceView;
}

export interface RunOverview {
  iterm: boolean;
  targets: RunTargetView[];
}

export type RunFailureReason =
  | "unknown-target"
  | "unknown-service"
  | "no-manifest"
  | "invalid-manifest"
  | "iterm-missing"
  | "no-readme"
  | "no-package"
  | "running"
  | "permission-denied"
  | "denied"
  | "not-running"
  | "nothing-to-do"
  | "failed";

export type RunActionResult = { ok: true; message: string } | { ok: false; reason: RunFailureReason; message: string };

const enabled: RunButtonState = { enabled: true, reason: null };
const disabled = (reason: string): RunButtonState => ({ enabled: false, reason });

const isActive = (state: RunServiceState): boolean => state !== "stopped";

export interface ButtonInput {
  manifest: RunManifestStatus;
  services: ReadonlyArray<Pick<RunServiceView, "role" | "state"> & { hasPort: boolean; hasSession: boolean }>;
  iterm: boolean;
}

export const runButtonStates = (input: ButtonInput): RunButtons => {
  if (input.manifest !== "ok") {
    const reason = input.manifest === "missing" ? "找不到可啟動服務" : "啟動設定有誤，請修正後再試";
    return {
      all: disabled(reason),
      web: disabled(reason),
      desktop: disabled(reason)
    };
  }

  const serving = input.services.filter((service) => service.role === "backend" || service.role === "frontend");
  const frontends = input.services.filter((service) => service.role === "frontend");
  const desktops = input.services.filter((service) => service.role === "desktop");

  let all: RunButtonState;
  if (serving.length === 0) all = disabled("沒有後端或前端服務");
  else if (!input.iterm) all = disabled("找不到 iTerm2");
  else if (serving.every((service) => isActive(service.state))) all = disabled("已在執行中");
  else all = enabled;

  let web: RunButtonState;
  if (frontends.length === 0) web = disabled("沒有網頁前端");
  else if (!frontends.some((service) => service.state === "running")) web = disabled("前端尚未啟動（先按一鍵前後端）");
  else web = enabled;

  let desktop: RunButtonState;
  if (desktops.length === 0) desktop = disabled("沒有桌面版");
  else if (!input.iterm) desktop = disabled("找不到 iTerm2");
  else if (desktops.every((service) => service.hasPort && isActive(service.state))) desktop = disabled("桌面版已在執行中");
  else desktop = enabled;

  return { all, web, desktop };
};

export const runServiceButtonStates = (
  service: Pick<RunServiceView, "role" | "state"> & { hasPort: boolean; hasSession: boolean; releasable?: boolean },
  iterm: boolean
): RunServiceButtons => {
  const active = isActive(service.state) || service.hasSession;

  let start: RunButtonState;
  if (!iterm) start = disabled("找不到 iTerm2");
  else if (active && service.hasPort) start = disabled("已在執行中");
  else if (active && !service.hasPort) start = disabled("已送出啟動");
  else start = enabled;

  let web: RunButtonState;
  if (service.role !== "frontend") web = disabled("不是網頁前端");
  else if (service.state !== "running") web = disabled("前端尚未啟動");
  else web = enabled;

  const release = service.releasable === true || service.hasSession ? enabled : disabled("沒有需要釋放的 port");

  return { start, web, release };
};

// ---------------------------------------------------------------------------
// 重裝依賴
// ---------------------------------------------------------------------------

export const INSTALL_MANAGERS = ["pnpm", "npm", "yarn", "bun"] as const;
export type InstallManager = (typeof INSTALL_MANAGERS)[number];

/** 刪掉 node_modules 再重裝；進到指令的只有白名單內的套件管理員名稱，沒有任何外部輸入。 */
export const reinstallCommand = (manager: InstallManager): string => `rm -rf node_modules && ${manager} install`;

export const reinstallButtonState = (input: { hasPackage: boolean; busy: boolean; iterm: boolean }): RunButtonState => {
  if (!input.hasPackage) return disabled("沒有 package.json，不是 Node 專案");
  if (input.busy) return disabled("請先結束執行中的服務");
  if (!input.iterm) return disabled("找不到 iTerm2");
  return enabled;
};

// ---------------------------------------------------------------------------
// 手機服務合併成一列
// ---------------------------------------------------------------------------

export type MobilePlatform = "ios" | "android";

const MOBILE_SEGMENT = /^(ios|android)(\d*)$/i;
const MOBILE_FALLBACK_TITLE = "mobile";

/**
 * 以連字號分隔的名稱片段是 ios 或 android 就算手機服務（flutter-ios、android-dev）；iosapp 不算。
 * 平台片段可以帶數字尾碼（ios2＝第二台 iOS），尾碼就是 variant，沒有尾碼為空字串。
 * app 是把平台片段拿掉後剩下的名稱：mobile-mahopurr-ios → mobile-mahopurr，只有平台名時為空字串。
 */
const mobileNameParts = (name: string): { platform: MobilePlatform; variant: string; app: string } | null => {
  const segments = name.split("-");
  const index = segments.findIndex((segment) => MOBILE_SEGMENT.test(segment));
  const match = MOBILE_SEGMENT.exec(segments[index] ?? "");
  const platform = match?.[1]?.toLowerCase();
  if (match === null || (platform !== "ios" && platform !== "android")) return null;
  return { platform, variant: match[2] ?? "", app: segments.filter((_, position) => position !== index).join("-") };
};

export const mobilePlatformOf = (name: string): MobilePlatform | null => mobileNameParts(name)?.platform ?? null;

export const RUN_STATE_LABEL: Record<RunServiceState, string> = { running: "執行中", starting: "啟動中", stopped: "未啟動" };
export const MOBILE_PLATFORM_LABEL: Record<MobilePlatform, string> = { ios: "iOS", android: "Android" };

/** 手機裝置的顯示名稱：平台名稱加上尾碼（iOS、iOS 2）。 */
export const mobileDeviceLabel = (platform: MobilePlatform, variant = ""): string =>
  variant === "" ? MOBILE_PLATFORM_LABEL[platform] : `${MOBILE_PLATFORM_LABEL[platform]} ${variant}`;

/**
 * 手機合併列的整列狀態：任一平台執行中算執行中，否則任一平台啟動中算啟動中，其餘未啟動；
 * 文字只列出不是停止的平台（iOS 執行中、Android 啟動中），全部停止就是「未啟動」。
 */
export const summarizeMobileState = (entries: ReadonlyArray<{ platform: MobilePlatform; variant?: string; state: RunServiceState }>): { state: RunServiceState; text: string } => {
  const state: RunServiceState = entries.some((entry) => entry.state === "running") ? "running" : entries.some((entry) => entry.state === "starting") ? "starting" : "stopped";
  const active = entries.filter((entry) => entry.state !== "stopped");
  const text = active.length === 0 ? RUN_STATE_LABEL.stopped : active.map((entry) => `${mobileDeviceLabel(entry.platform, entry.variant)} ${RUN_STATE_LABEL[entry.state]}`).join("、");
  return { state, text };
};

const PURR_SEGMENT = /^(.+)purr$/i;

/**
 * 服務名稱只能小寫（它也是依賴與佔位的 key），畫面上改用駝峰顯示：
 * 以連字號切段，凡是「某字加 purr」的片段在 purr 前切開並大寫 P（mahopurr → mahoPurr），其餘原樣。
 */
export const displayServiceName = (name: string): string =>
  name
    .split("-")
    .map((segment) => {
      const match = PURR_SEGMENT.exec(segment);
      return match === null ? segment : `${match[1] ?? ""}Purr`;
    })
    .join("-");

/** 後端群組列的標題與排序鍵；服務名稱只能是小寫英數與連字號，不會和一般服務撞名。 */
export const BACKEND_GROUP_TITLE = "後端";

export type RunServiceRow<T> =
  | { kind: "service"; service: T }
  | { kind: "backend"; title: string; services: T[] }
  | { kind: "mobile"; title: string; services: Array<{ platform: MobilePlatform; variant: string; service: T }> };

/**
 * 把服務清單整理成畫面上的列：一般服務各一列；手機服務依 app 名稱（去掉 ios／android 片段）分組，
 * 每個 app 合併成一列（iOS 在前），標題就是 app 名稱，位置落在該 app 第一個服務原本的位置。
 * 同一個 app 內同平台且尾碼相同的服務維持一般列，避免按鈕重名；尾碼不同（ios、ios2）併在同一列各佔一行。
 */
export const groupRunServices = <T extends { name: string; role?: RunRole }>(services: readonly T[]): Array<RunServiceRow<T>> => {
  const rows: Array<RunServiceRow<T>> = [];
  const apps = new Map<string, Extract<RunServiceRow<T>, { kind: "mobile" }>>();
  // 後端有兩個以上才合併成一列；只有一個時維持一般列，不多包一層。
  const backendCount = services.filter((service) => service.role === "backend" && mobileNameParts(service.name) === null).length;
  let backendRow: Extract<RunServiceRow<T>, { kind: "backend" }> | undefined;
  for (const service of services) {
    const parts = mobileNameParts(service.name);
    if (parts === null) {
      if (service.role === "backend" && backendCount >= 2) {
        if (backendRow === undefined) {
          backendRow = { kind: "backend", title: BACKEND_GROUP_TITLE, services: [] };
          rows.push(backendRow);
        }
        backendRow.services.push(service);
        continue;
      }
      rows.push({ kind: "service", service });
      continue;
    }
    let row = apps.get(parts.app);
    if (row === undefined) {
      row = { kind: "mobile", title: parts.app === "" ? MOBILE_FALLBACK_TITLE : parts.app, services: [] };
      apps.set(parts.app, row);
      rows.push(row);
    }
    if (row.services.some((entry) => entry.platform === parts.platform && entry.variant === parts.variant)) {
      rows.push({ kind: "service", service });
      continue;
    }
    row.services.push({ platform: parts.platform, variant: parts.variant, service });
  }
  for (const row of apps.values()) {
    row.services.sort((a, b) => Number(a.platform === "android") - Number(b.platform === "android") || Number(a.variant || 1) - Number(b.variant || 1));
  }
  return rows;
};

/** 後端群組列的整列狀態：任一執行中算執行中，否則任一啟動中算啟動中；沒有 port 的後端也以各自的 state 計。 */
export const summarizeBackendState = (entries: ReadonlyArray<{ state: RunServiceState }>): { state: RunServiceState; text: string } => {
  const running = entries.filter((entry) => entry.state === "running").length;
  const starting = entries.filter((entry) => entry.state === "starting").length;
  const state: RunServiceState = running > 0 ? "running" : starting > 0 ? "starting" : "stopped";
  const parts = [`${entries.length} 個後端`];
  if (running === 0 && starting === 0) parts.push(RUN_STATE_LABEL.stopped);
  if (running > 0) parts.push(`${running} 個執行中`);
  if (starting > 0) parts.push(`${starting} 個啟動中`);
  return { state, text: parts.join("，") };
};

export interface BackendGroupButtons {
  start: RunButtonState;
  release: RunButtonState;
}

/** 一組服務共用的按鈕狀態：組內任一服務可按就可按；全部不可按時沿用第一個服務的原因（已在執行中、找不到 iTerm2…）。 */
export const groupButtonState = (services: ReadonlyArray<{ buttons: RunServiceButtons }>, key: keyof RunServiceButtons): RunButtonState =>
  services.some((service) => service.buttons[key].enabled) ? enabled : (services[0]?.buttons[key] ?? disabled("沒有服務"));

export const backendGroupButtons = (services: ReadonlyArray<{ buttons: RunServiceButtons }>): BackendGroupButtons => ({
  start: groupButtonState(services, "start"),
  release: groupButtonState(services, "release")
});

// ---------------------------------------------------------------------------
// 目標識別
// ---------------------------------------------------------------------------

const TARGET_ID = /^([pf]):([1-9][0-9]{0,8})$/;

export const isRunTargetId = (value: unknown): value is string => typeof value === "string" && TARGET_ID.test(value);

/** 目標的 dev 通關密碼在保險庫裡的名稱：p:3 → devpass.p3。 */
export const passcodeSecretName = (targetId: string): string => `devpass.${targetId.replace(":", "")}`;

// ---------------------------------------------------------------------------
// dev 通關帳號
// ---------------------------------------------------------------------------

export const MAX_ACCOUNT_LENGTH = 200;

/** 去頭尾空白、限長、不含控制字元；空字串合法（代表沒有帳號），不合法回傳 null。 */
export const normalizeRunAccount = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > MAX_ACCOUNT_LENGTH || CONTROL.test(trimmed) ? null : trimmed;
};

// ---------------------------------------------------------------------------
// dev 通關密碼的來源：專案環境檔裡的某個鍵（GitNRun 只讀取，不保存、不寫入）
// ---------------------------------------------------------------------------

/** 只接受這幾種檔名；路徑可以帶資料夾（apps/edge/.dev.vars），但檔名本身必須在名單內。 */
export const PASSCODE_ENV_FILES = [".env", ".env.local", ".env.development", ".env.development.local", ".dev.vars"] as const;
export const MAX_PASSCODE_FILE_LENGTH = 200;
export const MAX_PASSCODE_FILE_SEGMENTS = 5;
export const MAX_PASSCODE_ENV_BYTES = 64 * 1024;
/** 這些前綴的變數會被打包進前端程式碼，不能拿來放密碼。 */
export const PUBLIC_ENV_PREFIXES = ["NEXT_PUBLIC_", "VITE_", "NUXT_PUBLIC_", "PUBLIC_", "EXPO_PUBLIC_"] as const;
const PASSCODE_KEY = /^[A-Z_][A-Z0-9_]{0,63}$/;

export interface PasscodeBinding {
  /** 相對專案資料夾的環境檔路徑，例如 .dev.vars 或 apps/edge/.dev.vars。 */
  file: string;
  key: string;
}

export type PasscodeSourceState = "unbound" | "ok" | "no-file" | "no-key" | "empty" | "unsafe";

export interface PasscodeSourceView {
  binding: PasscodeBinding | null;
  state: PasscodeSourceState;
  /** 讀到密碼時的末四碼（值太短為空字串）；明文不交給畫面。 */
  hint: string;
  /** 尚未綁定時，依框架偵測到的建議；只有檔案與鍵名，沒有值。 */
  candidates: PasscodeBinding[];
}

export const isPasscodeKey = (value: unknown): value is string =>
  typeof value === "string" && PASSCODE_KEY.test(value) && !PUBLIC_ENV_PREFIXES.some((prefix) => value.startsWith(prefix));

/** 相對路徑、不含 ..、每一段都非空、檔名在白名單內。 */
export const isPasscodeFile = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PASSCODE_FILE_LENGTH || CONTROL.test(value) || value.includes("\\")) {
    return false;
  }
  const segments = value.split("/");
  if (segments.length > MAX_PASSCODE_FILE_SEGMENTS || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return false;
  }
  return (PASSCODE_ENV_FILES as readonly string[]).includes(segments[segments.length - 1] ?? "");
};

/** 檔案與鍵名都合法才回傳；多餘欄位忽略。 */
export const normalizePasscodeBinding = (value: unknown): PasscodeBinding | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { file, key } = value as Record<string, unknown>;
  return isPasscodeFile(file) && isPasscodeKey(key) ? { file, key } : null;
};

/** 來源目前的狀態說明（不含檔案與鍵名）；畫面與複製失敗訊息共用。 */
export const passcodeStateText = (state: PasscodeSourceState): string => {
  switch (state) {
    case "ok":
      return "已讀到";
    case "unbound":
      return "還沒有指定密碼來源，請按「設定密碼」選擇環境檔";
    case "no-file":
      return "找不到這個環境檔";
    case "no-key":
      return "環境檔裡沒有這個鍵";
    case "empty":
      return "環境檔裡這個鍵的值是空的";
    case "unsafe":
      return `環境檔不安全（不是一般檔案、連結到專案外，或超過 ${MAX_PASSCODE_ENV_BYTES / 1024} KB）`;
  }
};

/** 帶上檔案與鍵名的完整說明，用在複製失敗的訊息。 */
export const passcodeProblem = (state: PasscodeSourceState, binding: PasscodeBinding | null): string =>
  `${binding === null ? "" : `${binding.file} 的 ${binding.key}：`}${passcodeStateText(state)}`;

export const parseRunTargetId = (value: string): { kind: "p" | "f"; id: number } | null => {
  const match = TARGET_ID.exec(value);
  return match ? { kind: match[1] === "f" ? "f" : "p", id: Number(match[2]) } : null;
};
