import { createHash } from "node:crypto";
import { basename, join, relative } from "node:path";
import { normalizeFolderPath } from "@shared/launcher";
import {
  MAX_ACCOUNT_LENGTH,
  RUN_MANIFEST_FILE,
  countFreshPorts,
  describeCommand,
  mobilePlatformOf,
  normalizePasscodeBinding,
  normalizeRunAccount,
  parseRunTargetId,
  passcodeProblem,
  passcodeSecretName,
  planStart,
  reinstallButtonState,
  reinstallCommand,
  runButtonStates,
  runServiceButtonStates,
  selectServices,
  urlForPort,
  type InstallManager,
  type MobilePlatform,
  type PasscodeBinding,
  type PasscodeSourceView,
  type RunAction,
  type RunActionResult,
  type RunFailureReason,
  type RunManifest,
  type RunOverview,
  type RunServiceSpec,
  type RunServiceState,
  type RunServiceView,
  type RunStartSelection,
  type RunTargetView
} from "@shared/run";
import { describeForeign, type PortOwnership } from "@shared/port-owner";
import type { PortSweepResult, PortSweepScan } from "@shared/port-sweep";
import { describeStale, isNodeStyleCommand, type StaleProcess } from "@shared/stale-process";
import type { Db } from "@main/db/database";
import { listProjects } from "@main/db/projects-repo";
import { UserFacingError } from "@main/errors";
import type { Logger } from "@main/logger";
import { AUTOMATION_DENIED, runSessionName, type ItermTab } from "@main/launcher/osascript";
import { iosUdidOfCommand } from "@shared/ios-simulator";
import { androidDeviceIdOf, serviceDirectory, type LoadedManifest } from "@main/run/manifest";
import { type PasscodeSourceReader } from "@main/run/passcode-source";
import type { PortSweep } from "@main/run/port-sweep";
import type { StaleProcesses } from "@main/run/stale-process";
import type { PortsFileService } from "@main/run/ports";
import {
  addRunFolder,
  getPasscodeBinding,
  getRunAccount,
  hasTrustedBefore,
  isPasscodeAutoBindBlocked,
  isRunTrusted,
  listRunFolders,
  removeRunFolder,
  setPasscodeAutoBindBlocked,
  setPasscodeBinding,
  setRunAccount,
  trustRunManifest
} from "@main/run/store";
import { secretHint, type Vault } from "@main/vault/vault";

/**
 * 專案啟動：列出專案、決定 port、在 iTerm2 開分頁、開網頁，以及每個專案的 dev 通關帳號與 Debug 密碼來源。
 * 全部是確定性邏輯，不呼叫任何 AI 服務；系統互動（探測、開視窗、對話框、剪貼簿）都由外部注入。
 */

export interface RunHandlerDeps {
  db: Db;
  logger: Pick<Logger, "log">;
  loadManifest: (folder: string) => Promise<LoadedManifest>;
  probe: (port: number) => Promise<boolean>;
  allocatePorts: (count: number, excluded?: readonly number[]) => Promise<number[]>;
  writePortsFile: (folder: string, services: Record<string, PortsFileService>, now: number) => Promise<boolean>;
  /** 讀回上次寫的 .dev/ports.json；GitNRun 重開後用來配合探測，認回還活著的服務。 */
  readPortsFile: (folder: string) => Promise<Record<string, number> | null>;
  discoverFolders?: () => Array<{ label: string; folder: string }>;
  itermAvailable: () => boolean;
  inspect: (path: string) => Promise<"dir" | "file" | "missing">;
  launchTabs: (tabs: ItermTab[]) => Promise<{ code: number; stderr: string }>;
  /** 結束這些 port 上屬於該專案資料夾的程序；別的程式占用的 port 不動。 */
  stopPorts: (ports: number[], folder: string) => Promise<{ code: number; stderr: string }>;
  /** 查這些 port 的監聽者哪些屬於該專案、哪些是別的程式；查不到的一律當作別人的。 */
  portOwners: (folder: string, ports: readonly number[]) => Promise<PortOwnership>;
  closeTabs: (sessionNames: string[]) => Promise<{ code: number; stderr: string }>;
  /** 關閉服務綁定的那一台模擬器（iOS 用 UDID，Android 用 AVD 名稱或序號）；那一台沒開著算成功。 */
  closeSimulator: (platform: MobilePlatform, deviceId: string) => Promise<{ code: number; stderr: string }>;
  /** 啟動 iOS 服務前讓它綁定的模擬器開機並顯示自己的視窗；沒注入就不處理。 */
  prepareSimulator?: (udid: string) => Promise<{ ok: boolean; message: string }>;
  /** 綁定 UDID 的 iOS 服務（沒有 port 可探測）是否還活著；沒注入就維持只看 session。 */
  iosServiceAlive?: (udid: string) => Promise<boolean>;
  /** 原生確認對話框；使用者按「允許」才回傳 true。 */
  confirmCommands: (request: ConfirmCommandsRequest) => Promise<boolean>;
  /** 刪除 node_modules 前的原生確認對話框；使用者按「刪除並重裝」才回傳 true。 */
  confirmReinstall: (request: ConfirmReinstallRequest) => Promise<boolean>;
  /** 重裝依賴用哪個套件管理員；資料夾沒有自己的宣告或 lock 檔時沿用 inherited。 */
  detectInstaller: (dir: string, inherited: InstallManager | null) => Promise<InstallManager>;
  /** 列出與結束終端機手動開的 port；pid 由主程序掃描，不由畫面傳入。 */
  portSweep: PortSweep;
  /** 專案資料夾裡的殘留程序（關掉視窗仍活著的桌面 app）；沒注入就不偵測也不清理。 */
  staleProcesses?: StaleProcesses;
  /** 啟動前發現殘留程序時的原生確認對話框；使用者按「結束後啟動」才回傳 true。 */
  confirmStale?: (request: ConfirmStaleRequest) => Promise<boolean>;
  /** 釋放 port 前的原生確認對話框；使用者按「釋放」才回傳 true。 */
  confirmRelease?: (request: ConfirmReleaseRequest) => Promise<boolean>;
  /** 啟動桌面服務後，等多久再檢查程序是否還在；0 = 不檢查。預設 5 秒。 */
  earlyExitCheckMs?: number;
  openUrl: (url: string) => Promise<void>;
  /** 猜服務用的框架（Django、Next.js…）；沒注入或辨識不出來都是 null，失敗不影響總覽。 */
  detectFramework?: (folder: string, spec: RunServiceSpec) => Promise<string | null>;
  /** 專案資料夾根目錄的 README.md 路徑；找不到回傳 null。 */
  findReadme: (folder: string) => string | null;
  /** 用文件預設的編輯器開檔；路徑一律由主程序算出（README 或綁定的環境檔），不接受畫面傳入。 */
  openDocument: (path: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  /** 舊版把 Debug 密碼存在密鑰保險庫；現在只剩讀狀態（提示）與刪除（清除）。 */
  vault: Pick<Vault, "getStatus" | "delete">;
  /** 把密碼放進剪貼簿並在一段時間後清掉；明文只在呼叫期間經手。 */
  copySecret: (secret: string) => Promise<void>;
  /** Debug 密碼來源：讀專案環境檔裡綁定的鍵、掃描候選、算出安全的檔案路徑。 */
  passcodeSource: PasscodeSourceReader;
  now: () => number;
  /** 指令送出後多久還沒開始監聽，就當作沒啟動成功。 */
  startingGraceMs?: number;
  /** 釋放 port 時等舊程序放掉 port 的上限與探測間隔；測試用。 */
  portRelease?: { timeoutMs: number; pollMs: number };
}

export interface ConfirmCommandsRequest {
  label: string;
  folder: string;
  /** 描述檔以前確認過、現在內容變了。 */
  changed: boolean;
  lines: Array<{ service: string; command: string }>;
}

export interface ConfirmStaleRequest {
  label: string;
  folder: string;
  processes: StaleProcess[];
}

export interface ConfirmReleaseRequest {
  label: string;
  folder: string;
  /** 這次要釋放的服務與各自占用中的 port；沒有程序在占用的服務也會列出。 */
  items: Array<{ service: string; ports: number[] }>;
  /** 資料夾裡的殘留程序（整批共用，只列一次）。 */
  processes: StaleProcess[];
}

export interface ConfirmReinstallRequest {
  label: string;
  folder: string;
  /** dir 是相對專案資料夾的路徑，專案根目錄為 "."。 */
  items: Array<{ dir: string; command: string }>;
}

export interface RunHandlers {
  overview(): Promise<RunOverview>;
  run(targetId: string, action: RunAction): Promise<RunActionResult>;
  addFolder(path: string): Promise<void>;
  removeFolder(targetId: string): void;
  /** 空字串 = 清除帳號。 */
  setAccount(targetId: string, account: string): void;
  /** 複製綁定的環境檔裡的 Debug 密碼；來源不可用時說明原因，不退回任何舊值。 */
  copyPasscode(targetId: string): Promise<void>;
  /** 指定 Debug 密碼讀哪個環境檔的哪個鍵；檔案可以還不存在。 */
  bindPasscode(targetId: string, binding: PasscodeBinding): void;
  unbindPasscode(targetId: string): void;
  /** 清掉候選快取，下次刷新重新掃描環境檔。 */
  recheckPasscode(targetId: string): void;
  /** 用文件編輯器開綁定的環境檔，讓你自己改密碼。 */
  openPasscodeFile(targetId: string): Promise<void>;
  /** 列出終端機手動開的 port 與占用它的程序，不結束任何東西。 */
  scanPorts(): Promise<PortSweepScan>;
  /** 結束所有終端機手動開的 port 的程序，並清掉對應服務的啟動記錄。 */
  releasePorts(): Promise<PortSweepResult>;
}

interface Target {
  id: string;
  label: string;
  folder: string;
  source: "project" | "folder" | "discovered";
  pathExists?: boolean;
}

interface Session {
  ports: Record<string, number>;
  startedAt: Record<string, number>;
}

export const DEFAULT_STARTING_GRACE_MS = 90_000;
export const DEFAULT_PORT_RELEASE = { timeoutMs: 5_000, pollMs: 150 } as const;
export const DEFAULT_EARLY_EXIT_CHECK_MS = 5_000;
const ERROR_TEXT_MAX = 300;
const CANDIDATE_CACHE_MS = 30_000;
const SIMULATOR_LABEL: Record<MobilePlatform, string> = { ios: "iOS", android: "Android" };

const fail = (reason: RunFailureReason, message: string): RunActionResult => ({ ok: false, reason, message });

const discoveredId = (folder: string, used: Set<string>): string => {
  const hash = createHash("sha256").update(folder).digest("hex");
  let value = 100_000_000 + (Number.parseInt(hash.slice(0, 8), 16) % 900_000_000);
  let id = `f:${value}`;
  while (used.has(id)) {
    value = value === 999_999_999 ? 100_000_000 : value + 1;
    id = `f:${value}`;
  }
  return id;
};

export const createRunHandlers = (deps: RunHandlerDeps): RunHandlers => {
  const { db } = deps;
  const grace = deps.startingGraceMs ?? DEFAULT_STARTING_GRACE_MS;
  const portRelease = deps.portRelease ?? DEFAULT_PORT_RELEASE;
  const sessions = new Map<string, Session>();
  const earlyExitCheckMs = deps.earlyExitCheckMs ?? DEFAULT_EARLY_EXIT_CHECK_MS;
  /** 啟動後程序立即消失的桌面服務（目標 id → 服務名稱）；結束時清掉。 */
  const earlyExits = new Map<string, Set<string>>();
  /** 每個目標在這次 GitNRun 執行期間只嘗試認回一次，避免每次刷新畫面都重新讀檔、重新探測。 */
  const reconciledTargets = new Set<string>();

  const targets = (): Target[] => {
    const seen = new Set<string>();
    const usedIds = new Set<string>();
    const result: Target[] = [];
    for (const project of listProjects(db)) {
      if (!project.localPath) continue;
      const folder = normalizeFolderPath(project.localPath);
      if (seen.has(folder)) continue;
      seen.add(folder);
      const id = `p:${project.id}`;
      usedIds.add(id);
      result.push({ id, label: project.name, folder, source: "project", pathExists: project.pathExists });
    }
    for (const entry of listRunFolders(db)) {
      if (seen.has(entry.path)) continue;
      seen.add(entry.path);
      const id = `f:${entry.id}`;
      usedIds.add(id);
      result.push({ id, label: basename(entry.path) || entry.path, folder: entry.path, source: "folder" });
    }
    for (const entry of deps.discoverFolders?.() ?? []) {
      const folder = normalizeFolderPath(entry.folder);
      if (!folder.startsWith("/") || seen.has(folder)) continue;
      seen.add(folder);
      const id = discoveredId(folder, usedIds);
      usedIds.add(id);
      result.push({ id, label: entry.label || basename(folder) || folder, folder, source: "discovered" });
    }
    return result;
  };

  const findTarget = (id: string): Target | null => targets().find((target) => target.id === id) ?? null;

  /** 候選掃描要讀好幾個檔案，畫面每幾秒就刷新一次，所以同一個目標短時間內沿用上次的結果。 */
  const candidateCache = new Map<string, { at: number; list: PasscodeBinding[] }>();

  /**
   * Debug 密碼的來源與狀態；明文只在這裡經手，只留下狀態與末四碼。
   * 所有專案走同一條路：沒綁定就掃環境檔，只找到一個候選且使用者沒手動解除過就自動綁定，多個候選交給使用者選。
   */
  const passcodeSourceOf = async (target: Target, scan: { serviceDirs: readonly string[] }): Promise<PasscodeSourceView> => {
    const bound = async (binding: PasscodeBinding): Promise<PasscodeSourceView> => {
      const read = await deps.passcodeSource.read(target.folder, binding);
      return { binding, state: read.state, hint: read.value === null ? "" : secretHint(read.value), candidates: [] };
    };
    const existing = getPasscodeBinding(db, target.id);
    if (existing !== null) return bound(existing);
    const now = deps.now();
    const cached = candidateCache.get(target.id);
    let list: PasscodeBinding[];
    if (cached !== undefined && now - cached.at < CANDIDATE_CACHE_MS) {
      list = cached.list;
    } else {
      list = await deps.passcodeSource.scan(target.folder, scan).catch(() => []);
      candidateCache.set(target.id, { at: now, list });
    }
    const only = list.length === 1 ? list[0] : undefined;
    if (only !== undefined && !isPasscodeAutoBindBlocked(db, target.id)) {
      setPasscodeBinding(db, target.id, only);
      return bound(only);
    }
    return { binding: null, state: "unbound", hint: "", candidates: list };
  };

  /** 服務目前的狀態：有配置過 port 且正在監聽 = 執行中；剛送出指令還沒監聽 = 啟動中。 */
  const serviceState = async (session: Session | undefined, name: string): Promise<{ state: RunServiceState; port: number | null }> => {
    const port = session?.ports[name];
    if (port === undefined) {
      return { state: "stopped", port: null };
    }
    if (await deps.probe(port)) {
      return { state: "running", port };
    }
    const startedAt = session?.startedAt[name];
    return startedAt !== undefined && deps.now() - startedAt < grace ? { state: "starting", port } : { state: "stopped", port: null };
  };

  /** 沒有 port 的 iOS 服務改用「模擬器開機 + flutter run 綁著它」判斷；其餘服務沿用 serviceState。 */
  const specState = async (session: Session | undefined, spec: RunServiceSpec): Promise<{ state: RunServiceState; port: number | null }> => {
    const udid = spec.port ? null : iosUdidOfCommand(spec.command);
    if (udid !== null && deps.iosServiceAlive !== undefined && (await deps.iosServiceAlive(udid).catch(() => false))) {
      return { state: "running", port: null };
    }
    return serviceState(session, spec.name);
  };

  /**
   * GitNRun 重開後，記憶體裡的 session 是空的，即使專案的服務其實還在跑。
   * 用上次寫的 .dev/ports.json（固定 port 的服務則直接用描述檔裡的號碼）配合即時探測，
   * 把還活著的服務認回來；每個目標這次執行只試一次，認不到就當作真的沒在跑。
   */
  const reconcileSession = async (target: Target, manifest: RunManifest): Promise<Session | undefined> => {
    const existing = sessions.get(target.id);
    if (reconciledTargets.has(target.id)) {
      return existing;
    }
    reconciledTargets.add(target.id);

    const portSpecs = manifest.services.filter((spec) => spec.port);
    if (portSpecs.length === 0) {
      return existing;
    }
    const recorded = await deps.readPortsFile(target.folder);
    const discovered: Record<string, number> = {};
    for (const spec of portSpecs) {
      const candidate = spec.fixedPort ?? recorded?.[spec.name];
      if (candidate !== undefined && (await deps.probe(candidate))) {
        discovered[spec.name] = candidate;
      }
    }
    if (Object.keys(discovered).length === 0) {
      return existing;
    }
    const next: Session = { ports: { ...existing?.ports, ...discovered }, startedAt: { ...existing?.startedAt } };
    sessions.set(target.id, next);
    return next;
  };

  /** 要刪 node_modules 重裝的資料夾：專案根目錄，加上服務工作目錄裡有自己 package.json 的子資料夾。 */
  const installDirectories = async (target: Target, loaded: LoadedManifest): Promise<string[]> => {
    const candidates = [target.folder];
    if (loaded.status === "ok") {
      for (const spec of loaded.manifest.services) candidates.push(serviceDirectory(target.folder, spec.cwd));
    }
    const dirs: string[] = [];
    for (const dir of candidates) {
      if (!dirs.includes(dir) && (await deps.inspect(join(dir, "package.json"))) === "file") dirs.push(dir);
    }
    return dirs;
  };

  const viewOf = async (target: Target, itermAvailable: boolean): Promise<RunTargetView> => {
    const loaded = await deps.loadManifest(target.folder);
    const base = {
      id: target.id,
      label: target.label,
      folder: target.folder,
      source: target.source,
      pathExists: target.pathExists,
      account: getRunAccount(db, target.id),
      legacyPasscode: deps.vault.getStatus(passcodeSecretName(target.id)),
      readme: deps.findReadme(target.folder) === null ? { enabled: false, reason: "找不到 README.md" } : { enabled: true, reason: null }
    };
    if (loaded.status !== "ok") {
      const manifest = loaded.status;
      const errors = loaded.status === "invalid" ? loaded.errors : [];
      return {
        ...base,
        passcodeSource: await passcodeSourceOf(target, { serviceDirs: [] }),
        manifest,
        errors,
        trusted: false,
        services: [],
        buttons: runButtonStates({ manifest, services: [], iterm: itermAvailable }),
        reinstall: reinstallButtonState({ hasPackage: (await installDirectories(target, loaded)).length > 0, busy: false, iterm: itermAvailable })
      };
    }

    const session = await reconcileSession(target, loaded.manifest);
    const recordedPorts = await deps.readPortsFile(target.folder);
    const services: RunServiceView[] = await Promise.all(
      loaded.manifest.services.map(async (spec) => {
        const { state, port } = await specState(session, spec);
        const serviceForButtons = {
          role: spec.role,
          state,
          hasPort: spec.port,
          hasSession: !spec.port && session?.startedAt[spec.name] !== undefined,
          // 有 port 的服務：記得 port、記錄檔有、或固定 port；桌面類服務可能留有殘留程序，一律可按。
          releasable:
            isDesktopLike(spec) ||
            (spec.port && (port !== null || session?.ports[spec.name] !== undefined || recordedPorts?.[spec.name] !== undefined || spec.fixedPort !== undefined))
        };
        return {
          name: spec.name,
          role: spec.role,
          port,
          fixedPort: spec.fixedPort ?? null,
          url: port === null ? null : urlForPort(port),
          state,
          ...(earlyExits.get(target.id)?.has(spec.name) === true ? { exitedEarly: true } : {}),
          command: describeCommand(spec),
          framework: (await deps.detectFramework?.(target.folder, spec).catch(() => null)) ?? null,
          buttons: runServiceButtonStates(serviceForButtons, itermAvailable)
        };
      })
    );
    const passcodeSource = await passcodeSourceOf(target, {
      serviceDirs: loaded.manifest.services.map((spec) => serviceDirectory(target.folder, spec.cwd))
    });
    return {
      ...base,
      passcodeSource,
      manifest: "ok",
      errors: [],
      trusted: isRunTrusted(db, target.folder, loaded.hash),
      services,
      buttons: runButtonStates({
        manifest: "ok",
        services: services.map((service, index) => ({
          role: service.role,
          state: service.state,
          hasPort: loaded.manifest.services[index]?.port === true,
          hasSession: loaded.manifest.services[index]?.port !== true && session?.startedAt[service.name] !== undefined
        })),
        iterm: itermAvailable
      }),
      reinstall: reinstallButtonState({
        hasPackage: (await installDirectories(target, loaded)).length > 0,
        // 與「釋放全部 port」可按的條件一致：有服務在跑，或沒有 port 的服務已送出啟動。
        busy: services.some((service, index) => service.state !== "stopped" || (loaded.manifest.services[index]?.port !== true && session?.startedAt[service.name] !== undefined)),
        iterm: itermAvailable
      })
    };
  };

  const log =(level: "info" | "warn", message: string, detail?: unknown): void =>
    deps.logger.log({ category: "command", level, message, ...(detail === undefined ? {} : { detail }) });

  const openWeb = async (target: Target, manifest: RunManifest, serviceName?: string): Promise<RunActionResult> => {
    const session = sessions.get(target.id);
    const urls: string[] = [];
    for (const spec of manifest.services) {
      if (serviceName !== undefined && spec.name !== serviceName) continue;
      if (spec.role !== "frontend") continue;
      const { state, port } = await serviceState(session, spec.name);
      if (state === "running" && port !== null) urls.push(urlForPort(port));
    }
    if (serviceName !== undefined && !manifest.services.some((spec) => spec.name === serviceName && spec.role === "frontend")) {
      return fail("unknown-service", "找不到這個網頁服務");
    }
    if (urls.length === 0) {
      return fail("not-running", "前端尚未啟動");
    }
    for (const url of urls) {
      await deps.openUrl(url);
    }
    log("info", `已用瀏覽器開啟 ${target.label}：${urls.join("、")}`);
    return { ok: true, message: `已開啟 ${urls.join("、")}` };
  };

  const openReadme = async (target: Target): Promise<RunActionResult> => {
    const path = deps.findReadme(target.folder);
    if (path === null) {
      return fail("no-readme", "找不到 README.md");
    }
    const result = await deps.openDocument(path);
    if (!result.ok) {
      return fail("failed", result.message);
    }
    log("info", `已開啟 ${target.label} 的 README.md`);
    return { ok: true, message: "已開啟 README.md" };
  };

  /** 結束 port 上的程序只送出終止訊號，程序可能還在收尾；等到沒人監聽才回傳 null，超過上限回傳仍被占用的 port。 */
  const waitForPortsFree = async (ports: readonly number[]): Promise<number | null> => {
    const attempts = Math.ceil(portRelease.timeoutMs / portRelease.pollMs);
    for (let attempt = 0; ; attempt += 1) {
      let busy: number | null = null;
      for (const port of ports) {
        if (await deps.probe(port)) {
          busy = port;
          break;
        }
      }
      if (busy === null || attempt >= attempts) return busy;
      await new Promise<void>((resolve) => setTimeout(resolve, portRelease.pollMs));
    }
  };

  /**
   * 這次結束的手機服務各自綁定的模擬器才會關（iOS 在前）；指令沒指定到哪一台（例如 `-d emulator`）就不關，
   * 避免連帶關掉別的專案開著的模擬器。回傳實際關掉的平台與因沒有綁定而略過的平台。
   */
  const closeSimulators = async (
    target: Target,
    names: readonly string[],
    specs: readonly RunServiceSpec[] = []
  ): Promise<{ platforms: MobilePlatform[]; skipped: MobilePlatform[]; failure: RunActionResult | null }> => {
    const used = new Set(names.map((name) => mobilePlatformOf(name)));
    const platforms: MobilePlatform[] = [];
    const skipped: MobilePlatform[] = [];
    let failure: RunActionResult | null = null;
    for (const platform of (["ios", "android"] as const).filter((item) => used.has(item))) {
      const service = specs.find((spec) => names.includes(spec.name) && mobilePlatformOf(spec.name) === platform);
      const deviceId = service === undefined ? null : platform === "ios" ? iosUdidOfCommand(service.command) : androidDeviceIdOf(service.command);
      if (deviceId === null) {
        skipped.push(platform);
        log("info", `${target.label} 的 ${SIMULATOR_LABEL[platform]} 服務沒有指定裝置，沒有關閉模擬器`);
        continue;
      }
      const result = await deps.closeSimulator(platform, deviceId);
      if (result.code === 0) {
        platforms.push(platform);
        continue;
      }
      const detail = result.stderr.trim().slice(0, ERROR_TEXT_MAX) || "未知錯誤";
      log("warn", `已結束 ${target.label}，但無法關閉 ${SIMULATOR_LABEL[platform]} 模擬器：${detail}`);
      if (failure === null) failure = fail("failed", `服務已結束，但無法關閉 ${SIMULATOR_LABEL[platform]} 模擬器：${detail}`);
    }
    return { platforms, skipped, failure };
  };

  /** 角色是 desktop、也不是手機的服務（桌面 app，有沒有 port 都算）：關掉視窗後程序可能還活著，GitNRun 只能靠程序清單找到它。 */
  const isDesktopLike = (spec: RunServiceSpec): boolean => spec.role === "desktop" && mobilePlatformOf(spec.name) === null;

  /** 只有涉及桌面類服務時才找資料夾裡的殘留程序；掃描失敗當作沒有，不擋住啟動與結束。 */
  const findStale = async (target: Target, specs: readonly RunServiceSpec[]): Promise<StaleProcess[]> => {
    if (deps.staleProcesses === undefined || !specs.some(isDesktopLike)) return [];
    try {
      return await deps.staleProcesses.scan(target.folder);
    } catch (error) {
      log("warn", `無法檢查 ${target.label} 的殘留程序：${error instanceof Error ? error.message : "未知錯誤"}`);
      return [];
    }
  };

  /** 結束殘留程序；全部結束回傳 null，有結束不掉的回傳失敗結果。 */
  const endStale = async (target: Target, list: readonly StaleProcess[]): Promise<RunActionResult | null> => {
    if (deps.staleProcesses === undefined || list.length === 0) return null;
    const { failed } = await deps.staleProcesses.end(list);
    if (failed.length > 0) {
      const pids = failed.map((item) => item.pid).join("、");
      log("warn", `無法結束 ${target.label} 的殘留程序：PID ${pids}`);
      return fail("failed", `無法結束殘留程序（PID ${pids}），請到活動監視器處理`);
    }
    log("info", `已結束 ${target.label} 的 ${list.length} 個殘留程序`, { pids: list.map((item) => item.pid) });
    return null;
  };

  /**
   * 釋放一組服務的 port、殘留程序、終端機分頁與（手機服務綁定的）模擬器：port 取 session、.dev/ports.json 與固定 port 的聯集，
   * 不要求目前探測得到。GitNRun 重開、記錄遺失之後，舊程序還占著 port 時就靠這裡清乾淨；只動指定的服務，同專案其他服務不受影響。
   * 整批只確認一次、port 一次結束並一起等釋放。
   */
  const release = async (target: Target, manifest: RunManifest, names: readonly string[]): Promise<RunActionResult> => {
    const specs = names.map((name) => manifest.services.find((item) => item.name === name));
    if (specs.length === 0 || specs.some((spec) => spec === undefined)) {
      return fail("unknown-service", "找不到這個服務");
    }
    const picked = specs.filter((spec): spec is RunServiceSpec => spec !== undefined);
    const session = sessions.get(target.id);
    const recorded = await deps.readPortsFile(target.folder);
    const items: Array<{ spec: RunServiceSpec; known: number[]; listening: number[]; hadSession: boolean }> = [];
    for (const spec of picked) {
      const candidates = spec.port ? [session?.ports[spec.name], recorded?.[spec.name], spec.fixedPort] : [];
      const known = [...new Set(candidates.filter((port): port is number => port !== undefined))];
      const listening: number[] = [];
      for (const port of known) {
        if (await deps.probe(port)) listening.push(port);
      }
      items.push({ spec, known, listening, hadSession: session?.startedAt[spec.name] !== undefined });
    }
    const stale = await findStale(target, picked);
    if (stale.length === 0 && items.every((item) => item.known.length === 0 && !item.hadSession)) {
      return fail("nothing-to-do", "沒有需要釋放的 port");
    }

    // 候選 port 可能是舊記錄或固定 port，之後被別的專案占用；只處理屬於這個專案資料夾的監聽程序。
    const probed = [...new Set(items.flatMap((item) => item.listening))];
    const ownership = probed.length > 0 ? await deps.portOwners(target.folder, probed) : { owned: [], foreign: [] };
    const ownedPorts = new Set(ownership.owned.map((entry) => entry.port));
    for (const item of items) item.listening = item.listening.filter((port) => ownedPorts.has(port));
    const foreignPorts = new Set(ownership.foreign.map((entry) => entry.port));
    const foreignNote = ownership.foreign.length > 0 ? `；略過被其他程式占用的 ${describeForeign(ownership.foreign)}，沒有結束` : "";
    if (ownership.foreign.length > 0) log("warn", `釋放 ${target.label} 時略過被其他程式占用的 ${describeForeign(ownership.foreign)}`);

    // 只有真的要結束別人的程序才需要確認；沒有任何程序在跑時只是清掉記錄與分頁。
    const listening = [...new Set(items.flatMap((item) => item.listening))];
    if (listening.length > 0 || stale.length > 0) {
      const allowed = (await deps.confirmRelease?.({
        label: target.label,
        folder: target.folder,
        items: items.map((item) => ({ service: item.spec.name, ports: item.listening })),
        processes: stale
      })) === true;
      if (!allowed) {
        log("warn", `已取消釋放 ${target.label} 的 ${picked.map((spec) => spec.name).join("、")}`);
        return fail("denied", "你取消了釋放，沒有結束任何程序");
      }
    }

    if (listening.length > 0) {
      const result = await deps.stopPorts(listening, target.folder);
      if (result.code !== 0) {
        const detail = result.stderr.trim().slice(0, ERROR_TEXT_MAX) || "未知錯誤";
        log("warn", `無法釋放 ${target.label}：${detail}`);
        return fail("failed", `無法釋放：${detail}`);
      }
      const busyPort = await waitForPortsFree(listening.filter((port) => !foreignPorts.has(port)));
      if (busyPort !== null) {
        log("warn", `無法釋放 ${target.label}：port ${busyPort} 仍被占用`);
        return fail("failed", `port ${busyPort} 仍被占用，可能是其他使用者的程序，請到活動監視器處理`);
      }
    }
    const staleFailure = await endStale(target, stale);
    if (staleFailure !== null) return staleFailure;

    if (session) {
      for (const { spec } of items) {
        delete session.ports[spec.name];
        delete session.startedAt[spec.name];
      }
      if (Object.keys(session.ports).length === 0 && Object.keys(session.startedAt).length === 0) sessions.delete(target.id);
    }
    for (const { spec } of items) earlyExits.get(target.id)?.delete(spec.name);
    const remaining: Record<string, PortsFileService> = {};
    for (const item of manifest.services) {
      const port = sessions.get(target.id)?.ports[item.name];
      if (item.port && port !== undefined) remaining[item.name] = { role: item.role, port };
    }
    await deps.writePortsFile(target.folder, remaining, deps.now());

    const opened = items.filter((item) => item.hadSession).map((item) => item.spec.name);
    let tabNote = "";
    let tabFailure: RunActionResult | null = null;
    if (opened.length > 0 && deps.itermAvailable()) {
      const closed = await deps.closeTabs(opened.map((name) => runSessionName(target.id, name)));
      if (closed.code !== 0 && AUTOMATION_DENIED.test(closed.stderr)) {
        tabFailure = fail("permission-denied", "已釋放，但 macOS 沒有允許 GitNRun 控制 iTerm2，分頁沒有關閉。請到「系統設定 → 隱私權與安全性 → 自動化」開啟後再試一次。");
      } else if (closed.code !== 0) {
        log("warn", `已釋放 ${target.label}，但無法關閉 iTerm2 分頁：${closed.stderr.trim().slice(0, ERROR_TEXT_MAX) || "未知錯誤"}`);
        tabNote = "，但分頁沒有關閉";
      }
    }

    // 手機服務釋放時連綁定的模擬器一起關；失敗在其他清理都完成後才回報。
    const simulators = await closeSimulators(target, opened, manifest.services);

    const parts = [
      listening.length > 0 ? `port ${listening.join("、")}` : null,
      stale.length > 0 ? `${stale.length} 個殘留程序` : null
    ].filter((part): part is string => part !== null);
    const subject = picked.length === 1 ? (picked[0] as RunServiceSpec).name : `${picked.length} 個服務`;
    const simulatorNote = [
      ...simulators.platforms.map((platform) => `，並關閉 ${SIMULATOR_LABEL[platform]} 模擬器`),
      ...simulators.skipped.map((platform) => `；${SIMULATOR_LABEL[platform]} 服務沒有指定裝置，沒有關閉模擬器`)
    ].join("");
    const summary = `${parts.length > 0 ? `已釋放 ${subject}：${parts.join("、")}` : `${subject} 沒有程序在占用，已清掉啟動記錄`}${foreignNote}`;
    log("info", `${summary}（${target.label}）${simulatorNote}`);
    if (tabFailure !== null) return tabFailure;
    if (simulators.failure !== null) return simulators.failure;
    return { ok: true, message: `${summary}${simulatorNote}${tabNote}` };
  };

  /**
   * 桌面服務啟動一小段時間後，資料夾裡已經沒有任何開發程序，代表它一啟動就退出了（例如被單一實例鎖擋掉）。
   * 分頁只會看到指令一閃而過，所以在畫面標示出來；期間被結束就不判斷。
   */
  const watchEarlyExit = async (target: Target, names: readonly string[], startedAt: number): Promise<void> => {
    if (deps.staleProcesses === undefined || earlyExitCheckMs <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, earlyExitCheckMs));
    const session = sessions.get(target.id);
    const current = names.filter((name) => session?.startedAt[name] === startedAt);
    if (current.length === 0) return;
    const alive = await deps.staleProcesses.scan(target.folder).catch(() => null);
    if (alive === null || alive.length > 0) return;
    const set = earlyExits.get(target.id) ?? new Set<string>();
    for (const name of current) set.add(name);
    earlyExits.set(target.id, set);
    log("warn", `${target.label} 啟動後程序立即退出：${current.join("、")}`);
  };

  // 同專案的啟動排隊執行：後到的前端要等前一個送出分頁、記錄 session 後再評估，才不會把已在啟動的後端再開一次。
  const startQueues = new Map<string, Promise<unknown>>();
  const serializeStart = (target: Target, run: () => Promise<RunActionResult>): Promise<RunActionResult> => {
    const result = (startQueues.get(target.id) ?? Promise.resolve()).then(run, run);
    const tail = result.catch(() => undefined);
    startQueues.set(target.id, tail);
    void tail.then(() => {
      if (startQueues.get(target.id) === tail) startQueues.delete(target.id);
    });
    return result;
  };

  const start = async (
    target: Target,
    loaded: Extract<LoadedManifest, { status: "ok" }>,
    selection: RunStartSelection
  ): Promise<RunActionResult> => {
    if (!deps.itermAvailable()) {
      return fail("iterm-missing", "找不到 iTerm2，請先安裝");
    }
    const { manifest } = loaded;
    const selected = selectServices(manifest, selection);
    if (selected.length === 0) {
      return typeof selection === "object" ? fail("unknown-service", "找不到這個服務") : fail("nothing-to-do", "這個專案沒有可啟動服務");
    }

    // 已在執行或正在啟動的服務：沿用它的 port，不再啟動。
    let session = sessions.get(target.id) ?? { ports: {}, startedAt: {} };
    const reuse: Record<string, number> = {};
    const skip = new Set<string>();
    for (const spec of manifest.services) {
      if (!spec.port) {
        // 沒有 port 的後端（worker、排程）只能靠工作階段判斷：已送出啟動就不重複開，要重開請先結束。
        if (spec.role === "backend" && session.startedAt[spec.name] !== undefined && selected.some((item) => item.name === spec.name)) {
          skip.add(spec.name);
        }
        continue;
      }
      const { state, port } = await serviceState(session, spec.name);
      if (state !== "stopped" && port !== null) {
        if (spec.fixedPort !== undefined && port !== spec.fixedPort) {
          return fail("failed", `${spec.name} 正在使用 port ${port}；固定 port 已改為 ${spec.fixedPort}，請先結束該服務再啟動`);
        }
        reuse[spec.name] = port;
        if (selected.some((item) => item.name === spec.name)) skip.add(spec.name);
      }
    }

    const fixedToLaunch = selected.filter((spec) => spec.fixedPort !== undefined && !skip.has(spec.name));
    for (const spec of fixedToLaunch) {
      const port = spec.fixedPort as number;
      if (await deps.probe(port)) {
        return fail("failed", `${spec.name} 的固定 port ${port} 已被占用；請按該服務列的「釋放 port」，沒有改用其他號碼`);
      }
    }

    if (selected.every((item) => skip.has(item.name))) {
      const urls = selected.map((item) => reuse[item.name]).filter((port): port is number => port !== undefined).map(urlForPort);
      return { ok: true, message: `已經在執行中：${(urls.length > 0 ? urls : selected.map((item) => item.name)).join("、")}` };
    }

    if (!isRunTrusted(db, target.folder, loaded.hash)) {
      const allowed = await deps.confirmCommands({
        label: target.label,
        folder: target.folder,
        changed: hasTrustedBefore(db, target.folder),
        lines: manifest.services.map((spec) => ({ service: spec.name, command: describeCommand(spec) }))
      });
      if (!allowed) {
        log("warn", `已拒絕執行 ${target.label} 的啟動指令`);
        return fail("denied", "你拒絕了這份啟動指令，沒有執行任何東西");
      }
      trustRunManifest(db, target.folder, loaded.hash);
    }

    for (const spec of fixedToLaunch) {
      const port = spec.fixedPort as number;
      if (await deps.probe(port)) {
        return fail("failed", `${spec.name} 的固定 port ${port} 已被占用；請按該服務列的「釋放 port」，沒有啟動`);
      }
    }

    const excluded = [...manifest.services.flatMap((spec) => spec.fixedPort === undefined ? [] : [spec.fixedPort]), ...Object.values(reuse)];
    const fresh = await deps.allocatePorts(countFreshPorts(manifest, reuse), excluded);
    const plan = planStart(manifest, selection, reuse, skip, fresh);
    const tabs: ItermTab[] = plan.starts.map((item) => ({
      dir: serviceDirectory(target.folder, item.cwd),
      name: runSessionName(target.id, item.name),
      command: item.commandLine
    }));

    // 桌面 app 常有單一實例鎖：舊的還留在背景時，新的會被擋掉並立刻退出，所以先找殘留程序，確認後結束再啟動。
    // 同專案有 port 服務正在跑時分不出哪些是它們的程序，這時跳過，交給啟動後的立即退出偵測。
    const desktopStarts = plan.starts.filter((item) => manifest.services.some((spec) => spec.name === item.name && isDesktopLike(spec)));
    const portServices = manifest.services.filter((spec) => spec.port);
    const portBusy = (await Promise.all(portServices.map((spec) => serviceState(session, spec.name)))).some((item) => item.state !== "stopped");
    const stale = portBusy ? [] : await findStale(target, manifest.services.filter((spec) => desktopStarts.some((item) => item.name === spec.name)));
    if (stale.length > 0) {
      const allowed = (await deps.confirmStale?.({ label: target.label, folder: target.folder, processes: stale })) === true;
      if (!allowed) {
        log("warn", `已取消啟動 ${target.label}：資料夾裡還有 ${stale.length} 個殘留程序`);
        return fail("denied", `${target.label} 還有 ${stale.length} 個舊程序在背景執行，沒有啟動；請先結束它們`);
      }
      const staleFailure = await endStale(target, stale);
      if (staleFailure !== null) return staleFailure;
    }

    // iOS 服務綁定的模擬器先開機並補上自己的視窗；失敗只記錄，不擋後面的啟動。
    if (deps.prepareSimulator !== undefined) {
      for (const item of plan.starts) {
        if (mobilePlatformOf(item.name) !== "ios") continue;
        const spec = manifest.services.find((candidate) => candidate.name === item.name);
        const udid = spec === undefined ? null : iosUdidOfCommand(spec.command);
        if (udid === null) continue;
        const prepared = await deps.prepareSimulator(udid);
        log(prepared.ok ? "info" : "warn", `${target.label} ${item.name}：${prepared.message}`);
      }
    }

    const result = await deps.launchTabs(tabs);
    if (result.code !== 0) {
      if (AUTOMATION_DENIED.test(result.stderr)) {
        return fail("permission-denied", "macOS 沒有允許 GitNRun 控制 iTerm2。請到「系統設定 → 隱私權與安全性 → 自動化」開啟後再試一次。");
      }
      const detail = result.stderr.trim().slice(0, ERROR_TEXT_MAX) || "未知錯誤";
      log("warn", `無法在 iTerm2 啟動 ${target.label}：${detail}`);
      return fail("failed", `無法在 iTerm2 開啟：${detail}`);
    }

    // 只有真的送出指令之後才記錄：沿用的 port 與這次新啟動的服務。
    const now = deps.now();
    const next: Session = { ports: { ...session.ports }, startedAt: { ...session.startedAt } };
    for (const item of plan.starts) {
      next.startedAt[item.name] = now;
      if (item.port !== null) {
        next.ports[item.name] = item.port;
      }
    }
    for (const [name, port] of Object.entries(reuse)) {
      if (!plan.starts.some((item) => item.name === name)) next.ports[name] = port;
    }
    sessions.set(target.id, next);
    for (const item of desktopStarts) earlyExits.get(target.id)?.delete(item.name);
    const watched = desktopStarts.filter((item) => manifest.services.some((spec) => spec.name === item.name && isNodeStyleCommand(spec.command))).map((item) => item.name);
    if (watched.length > 0) void watchEarlyExit(target, watched, now);

    const known: Record<string, PortsFileService> = {};
    for (const spec of manifest.services) {
      const port = next.ports[spec.name];
      if (spec.port && port !== undefined && (plan.starts.some((item) => item.name === spec.name) || reuse[spec.name] !== undefined)) {
        known[spec.name] = { role: spec.role, port };
      }
    }
    await deps.writePortsFile(target.folder, known, now);

    const names = plan.starts.map((item) => item.name);
    log("info", `已在 iTerm2 啟動 ${target.label}：${names.join("、")}`, {
      commands: tabs.map((item) => ({ service: item.name, commandLine: item.command }))
    });
    return { ok: true, message: `已在 iTerm2 開啟 ${names.length} 個分頁：${names.join("、")}` };
  };

  /** 專案裡有服務在跑、啟動中，或沒有 port 的服務已送出啟動；刪掉依賴會讓這些服務直接掛掉。 */
  const hasActiveServices = async (target: Target, manifest: RunManifest): Promise<boolean> => {
    const session = sessions.get(target.id);
    for (const spec of manifest.services) {
      const { state } = await specState(session, spec);
      if (state !== "stopped" || (!spec.port && session?.startedAt[spec.name] !== undefined)) return true;
    }
    return false;
  };

  /** 在 iTerm2 開分頁刪除 node_modules 並重裝；不需要啟動描述檔，每次都要原生對話框確認。 */
  const reinstall = async (target: Target): Promise<RunActionResult> => {
    if (!deps.itermAvailable()) {
      return fail("iterm-missing", "找不到 iTerm2，請先安裝");
    }
    const loaded = await deps.loadManifest(target.folder);
    if (loaded.status === "ok" && (await hasActiveServices(target, loaded.manifest))) {
      return fail("running", "請先結束這個專案執行中的服務，再重裝依賴");
    }
    const dirs = await installDirectories(target, loaded);
    if (dirs.length === 0) {
      return fail("no-package", "找不到 package.json，不是 Node 專案");
    }

    // 子資料夾沒有自己的 lock 檔時，沿用專案根目錄的套件管理員。
    const items: Array<{ dir: string; command: string }> = [];
    let rootManager: InstallManager | null = null;
    for (const dir of dirs) {
      const isRoot = dir === target.folder;
      const manager = await deps.detectInstaller(dir, isRoot ? null : rootManager);
      if (isRoot) rootManager = manager;
      items.push({ dir, command: reinstallCommand(manager) });
    }

    const allowed = await deps.confirmReinstall({
      label: target.label,
      folder: target.folder,
      items: items.map((item) => ({ dir: relative(target.folder, item.dir) || ".", command: item.command }))
    });
    if (!allowed) {
      log("warn", `已取消重裝 ${target.label} 的依賴`);
      return fail("denied", "你取消了重裝依賴，沒有刪除任何東西");
    }

    const tabs: ItermTab[] = items.map((item, index) => ({
      dir: item.dir,
      name: runSessionName(target.id, index === 0 ? "Reinstall" : `Reinstall-${index + 1}`),
      command: item.command
    }));
    const result = await deps.launchTabs(tabs);
    if (result.code !== 0) {
      if (AUTOMATION_DENIED.test(result.stderr)) {
        return fail("permission-denied", "macOS 沒有允許 GitNRun 控制 iTerm2。請到「系統設定 → 隱私權與安全性 → 自動化」開啟後再試一次。");
      }
      const detail = result.stderr.trim().slice(0, ERROR_TEXT_MAX) || "未知錯誤";
      log("warn", `無法在 iTerm2 重裝 ${target.label} 的依賴：${detail}`);
      return fail("failed", `無法在 iTerm2 開啟：${detail}`);
    }

    log("info", `已在 iTerm2 重裝 ${target.label} 的依賴`, { commands: items.map((item) => ({ dir: item.dir, commandLine: item.command })) });
    return { ok: true, message: `已在 iTerm2 開啟 ${tabs.length} 個分頁刪除 node_modules 並重裝依賴，進度請看終端機` };
  };

  return {
    async overview() {
      const itermAvailable = deps.itermAvailable();
      return {
        iterm: itermAvailable,
        targets: await Promise.all(targets().map((target) => viewOf(target, itermAvailable)))
      };
    },

    async run(targetId, action) {
      const target = findTarget(targetId);
      if (!target) {
        return fail("unknown-target", "找不到這個專案");
      }
      // README 與啟動描述檔無關，沒有描述檔的專案也要能開。
      if (action.scope === "project" && action.action === "readme") {
        return openReadme(target);
      }
      if (action.scope === "project" && action.action === "reinstall") {
        return reinstall(target);
      }
      const loaded = await deps.loadManifest(target.folder);
      if (loaded.status === "missing") {
        return fail("no-manifest", "找不到可啟動服務");
      }
      if (loaded.status === "invalid") {
        return fail("invalid-manifest", `描述檔有誤：${loaded.errors[0] ?? "未知原因"}`);
      }
      if (action.scope === "project") {
        if (action.action === "release-all") return release(target, loaded.manifest, loaded.manifest.services.map((spec) => spec.name));
        // 後端整組：釋放只動後端；啟動走同專案排隊，一次送出整批分頁。
        const backends = loaded.manifest.services.filter((spec) => spec.role === "backend").map((spec) => spec.name);
        if (backends.length === 0) return fail("nothing-to-do", "這個專案沒有後端服務");
        if (action.action === "release-backend") return release(target, loaded.manifest, backends);
        return serializeStart(target, () => start(target, loaded, "backend"));
      }
      if (action.action === "release") {
        return release(target, loaded.manifest, [action.service]);
      }
      if (action.action === "web") {
        return openWeb(target, loaded.manifest, action.service);
      }
      return serializeStart(target, () => start(target, loaded, { service: action.service }));
    },

    async addFolder(path) {
      if (!path.startsWith("/") || path.split("/").some((segment) => segment === "..")) {
        throw new UserFacingError("資料夾路徑必須是絕對路徑，且不能包含 ..");
      }
      const kind = await deps.inspect(normalizeFolderPath(path));
      if (kind === "missing") throw new UserFacingError("找不到這個資料夾");
      if (kind === "file") throw new UserFacingError("這個路徑不是資料夾");
      addRunFolder(db, path);
    },

    removeFolder(targetId) {
      const parsed = parseRunTargetId(targetId);
      if (parsed?.kind !== "f") {
        throw new UserFacingError("只能移除自己加入的資料夾");
      }
      removeRunFolder(db, parsed.id);
      sessions.delete(targetId);
      // 資料夾的識別號之後會被新加入的資料夾沿用，帳號與密碼來源不能留給下一個人。
      setRunAccount(db, targetId, "");
      setPasscodeBinding(db, targetId, null);
      candidateCache.delete(targetId);
      deps.vault.delete(passcodeSecretName(targetId));
    },

    setAccount(targetId, account) {
      if (!findTarget(targetId)) {
        throw new UserFacingError("找不到這個專案");
      }
      const normalized = normalizeRunAccount(account);
      if (normalized === null) {
        throw new UserFacingError(`帳號不能超過 ${MAX_ACCOUNT_LENGTH} 字，也不能含控制字元`);
      }
      setRunAccount(db, targetId, normalized);
    },

    async copyPasscode(targetId) {
      const target = findTarget(targetId);
      if (!target) {
        throw new UserFacingError("找不到這個專案");
      }
      const binding = getPasscodeBinding(db, targetId);
      if (binding === null) {
        throw new UserFacingError(passcodeProblem("unbound", null));
      }
      // 每次都重新讀檔：專案改了密碼，下一次複製就是新的；來源不可用時不退回任何舊值。
      const read = await deps.passcodeSource.read(target.folder, binding);
      if (read.state !== "ok" || read.value === null) {
        throw new UserFacingError(passcodeProblem(read.state, binding));
      }
      await deps.copySecret(read.value);
    },

    bindPasscode(targetId, binding) {
      if (!findTarget(targetId)) {
        throw new UserFacingError("找不到這個專案");
      }
      const normalized = normalizePasscodeBinding(binding);
      if (normalized === null) {
        throw new UserFacingError("環境檔需是專案內的 .env、.env.local、.env.development、.env.development.local 或 .dev.vars，鍵名需是大寫英數與底線，且不能是 NEXT_PUBLIC_、VITE_ 這類會公開的前綴");
      }
      setPasscodeBinding(db, targetId, normalized);
      setPasscodeAutoBindBlocked(db, targetId, false);
      candidateCache.delete(targetId);
    },

    unbindPasscode(targetId) {
      if (!findTarget(targetId)) {
        throw new UserFacingError("找不到這個專案");
      }
      setPasscodeBinding(db, targetId, null);
      setPasscodeAutoBindBlocked(db, targetId, true);
      candidateCache.delete(targetId);
    },

    recheckPasscode(targetId) {
      if (!findTarget(targetId)) {
        throw new UserFacingError("找不到這個專案");
      }
      candidateCache.delete(targetId);
    },

    async openPasscodeFile(targetId) {
      const target = findTarget(targetId);
      if (!target) {
        throw new UserFacingError("找不到這個專案");
      }
      const binding = getPasscodeBinding(db, targetId);
      if (binding === null) {
        throw new UserFacingError(passcodeProblem("unbound", null));
      }
      const path = await deps.passcodeSource.locate(target.folder, binding);
      if (path === null) {
        throw new UserFacingError(`找不到可以安全開啟的環境檔：${binding.file}`);
      }
      const result = await deps.openDocument(path);
      if (!result.ok) {
        throw new UserFacingError(result.message);
      }
      log("info", `已開啟 ${target.label} 的環境檔 ${binding.file}`);
    },

    scanPorts: () => deps.portSweep.scan(),

    async releasePorts() {
      const result = await deps.portSweep.release();
      // 被結束的 port 不再算 GitNRun 啟動的服務，否則卡片會停在「啟動中」。
      const endedPorts = new Set(result.ended.flatMap((item) => item.ports));
      for (const [targetId, session] of sessions) {
        for (const [name, port] of Object.entries(session.ports)) {
          if (!endedPorts.has(port)) continue;
          delete session.ports[name];
          delete session.startedAt[name];
        }
        if (Object.keys(session.ports).length === 0 && Object.keys(session.startedAt).length === 0) sessions.delete(targetId);
      }
      const describe = (items: typeof result.ended): string => items.map((item) => `${item.command}(${item.ports.join("、")})`).join("、");
      if (result.ended.length > 0) log("info", `已釋放終端機 port：${describe(result.ended)}`);
      if (result.failed.length > 0) log("warn", `無法結束占用 port 的程序：${describe(result.failed)}`);
      return result;
    }
  };
};
