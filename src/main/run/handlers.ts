import { createHash } from "node:crypto";
import { basename } from "node:path";
import { normalizeFolderPath } from "@shared/launcher";
import {
  MAX_ACCOUNT_LENGTH,
  RUN_MANIFEST_FILE,
  countFreshPorts,
  describeCommand,
  mobilePlatformOf,
  normalizeRunAccount,
  parseRunTargetId,
  passcodeSecretName,
  planStart,
  runButtonStates,
  runServiceButtonStates,
  selectServices,
  urlForPort,
  type MobilePlatform,
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
import type { Db } from "@main/db/database";
import { listProjects } from "@main/db/projects-repo";
import { UserFacingError } from "@main/errors";
import type { Logger } from "@main/logger";
import { AUTOMATION_DENIED, runSessionName, type ItermTab } from "@main/launcher/osascript";
import { serviceDirectory, type LoadedManifest } from "@main/run/manifest";
import type { PortsFileService } from "@main/run/ports";
import { addRunFolder, getRunAccount, hasTrustedBefore, isRunTrusted, listRunFolders, removeRunFolder, setRunAccount, trustRunManifest } from "@main/run/store";
import { SecretMissingError, SecretUnreadableError, type Vault } from "@main/vault/vault";

/**
 * 專案啟動：列出專案、決定 port、在 iTerm2 開分頁、開網頁，以及每個專案的 dev 通關帳號／密碼。
 * 全部是確定性邏輯，不呼叫任何 AI 服務；系統互動（探測、開視窗、對話框、剪貼簿）都由外部注入。
 */

export interface RunHandlerDeps {
  db: Db;
  logger: Pick<Logger, "log">;
  loadManifest: (folder: string) => Promise<LoadedManifest>;
  probe: (port: number) => Promise<boolean>;
  allocatePorts: (count: number) => Promise<number[]>;
  writePortsFile: (folder: string, services: Record<string, PortsFileService>, now: number) => Promise<boolean>;
  discoverFolders?: () => Array<{ label: string; folder: string }>;
  itermAvailable: () => boolean;
  inspect: (path: string) => Promise<"dir" | "file" | "missing">;
  launchTabs: (tabs: ItermTab[]) => Promise<{ code: number; stderr: string }>;
  stopPorts: (ports: number[]) => Promise<{ code: number; stderr: string }>;
  closeTabs: (sessionNames: string[]) => Promise<{ code: number; stderr: string }>;
  /** 關閉該平台目前開著的模擬器；沒有開著的模擬器算成功。 */
  closeSimulator: (platform: MobilePlatform) => Promise<{ code: number; stderr: string }>;
  /** 原生確認對話框；使用者按「允許」才回傳 true。 */
  confirmCommands: (request: ConfirmCommandsRequest) => Promise<boolean>;
  openUrl: (url: string) => Promise<void>;
  /** 猜服務用的框架（Django、Next.js…）；沒注入或辨識不出來都是 null，失敗不影響總覽。 */
  detectFramework?: (folder: string, spec: RunServiceSpec) => Promise<string | null>;
  /** 專案資料夾根目錄的 README.md 路徑；找不到回傳 null。 */
  findReadme: (folder: string) => string | null;
  /** 用文件預設的編輯器開檔；路徑一律由 findReadme 算出，不接受畫面傳入。 */
  openDocument: (path: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  /** dev 通關密碼存在密鑰保險庫；這裡只會讀狀態、刪除、以及交給 copySecret。 */
  vault: Pick<Vault, "isAvailable" | "getStatus" | "delete" | "useSecret">;
  /** 把密碼放進剪貼簿並在一段時間後清掉；明文只在呼叫期間經手。 */
  copySecret: (secret: string) => void;
  now: () => number;
  /** 指令送出後多久還沒開始監聽，就當作沒啟動成功。 */
  startingGraceMs?: number;
}

export interface ConfirmCommandsRequest {
  label: string;
  folder: string;
  /** 描述檔以前確認過、現在內容變了。 */
  changed: boolean;
  lines: Array<{ service: string; command: string }>;
}

export interface RunHandlers {
  overview(): Promise<RunOverview>;
  run(targetId: string, action: RunAction): Promise<RunActionResult>;
  addFolder(path: string): Promise<void>;
  removeFolder(targetId: string): void;
  /** 空字串 = 清除帳號。 */
  setAccount(targetId: string, account: string): void;
  copyPasscode(targetId: string): Promise<void>;
}

interface Target {
  id: string;
  label: string;
  folder: string;
  source: "project" | "folder" | "discovered";
}

interface Session {
  ports: Record<string, number>;
  startedAt: Record<string, number>;
}

export const DEFAULT_STARTING_GRACE_MS = 90_000;
const ERROR_TEXT_MAX = 300;
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
  const sessions = new Map<string, Session>();

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
      result.push({ id, label: project.name, folder, source: "project" });
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

  const viewOf = async (target: Target, itermAvailable: boolean): Promise<RunTargetView> => {
    const loaded = await deps.loadManifest(target.folder);
    const base = {
      id: target.id,
      label: target.label,
      folder: target.folder,
      source: target.source,
      account: getRunAccount(db, target.id),
      passcode: deps.vault.getStatus(passcodeSecretName(target.id)),
      readme: deps.findReadme(target.folder) === null ? { enabled: false, reason: "找不到 README.md" } : { enabled: true, reason: null }
    };
    if (loaded.status !== "ok") {
      const manifest = loaded.status;
      const errors = loaded.status === "invalid" ? loaded.errors : [];
      return {
        ...base,
        manifest,
        errors,
        trusted: false,
        services: [],
        buttons: runButtonStates({ manifest, services: [], iterm: itermAvailable })
      };
    }

    const session = sessions.get(target.id);
    const services: RunServiceView[] = await Promise.all(
      loaded.manifest.services.map(async (spec) => {
        const { state, port } = await serviceState(session, spec.name);
        const serviceForButtons = {
          role: spec.role,
          state,
          hasPort: spec.port,
          hasSession: !spec.port && session?.startedAt[spec.name] !== undefined
        };
        return {
          name: spec.name,
          role: spec.role,
          port,
          url: port === null ? null : urlForPort(port),
          state,
          command: describeCommand(spec),
          framework: (await deps.detectFramework?.(target.folder, spec).catch(() => null)) ?? null,
          buttons: runServiceButtonStates(serviceForButtons, itermAvailable)
        };
      })
    );
    return {
      ...base,
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
      })
    };
  };

  const log = (level: "info" | "warn", message: string, detail?: unknown): void =>
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

  const stopListeningCommand = (port: number): string =>
    `kill -TERM $(lsof -ti tcp:${port}) 2>/dev/null || true; sleep 0.5;`;

  /** 這次結束的服務裡，有哪些手機平台就關哪些模擬器（iOS 在前）；只關開過的平台，一般服務不動。 */
  const closeSimulators = async (
    target: Target,
    names: readonly string[]
  ): Promise<{ platforms: MobilePlatform[]; failure: RunActionResult | null }> => {
    const used = new Set(names.map((name) => mobilePlatformOf(name)));
    const platforms = (["ios", "android"] as const).filter((platform) => used.has(platform));
    let failure: RunActionResult | null = null;
    for (const platform of platforms) {
      const result = await deps.closeSimulator(platform);
      if (result.code === 0) continue;
      const detail = result.stderr.trim().slice(0, ERROR_TEXT_MAX) || "未知錯誤";
      log("warn", `已結束 ${target.label}，但無法關閉 ${SIMULATOR_LABEL[platform]} 模擬器：${detail}`);
      if (failure === null) failure = fail("failed", `服務已結束，但無法關閉 ${SIMULATOR_LABEL[platform]} 模擬器：${detail}`);
    }
    return { platforms, failure };
  };

  const stop = async (target: Target, manifest: RunManifest, serviceName?: string): Promise<RunActionResult> => {
    const session = sessions.get(target.id);
    if (!session) {
      return fail("nothing-to-do", "尚未啟動");
    }
    if (serviceName !== undefined && !manifest.services.some((spec) => spec.name === serviceName)) {
      return fail("unknown-service", "找不到這個服務");
    }

    const active: Array<{ name: string; port: number }> = [];
    // 有開過分頁的服務都要關分頁：沒有 port 的服務、以及已經掛掉但分頁還開著的服務也包含在內。
    const opened: string[] = [];
    for (const spec of manifest.services) {
      if (serviceName !== undefined && spec.name !== serviceName) continue;
      const { state, port } = await serviceState(session, spec.name);
      if (state !== "stopped" && port !== null) {
        active.push({ name: spec.name, port });
      }
      if ((state !== "stopped" && port !== null) || session.startedAt[spec.name] !== undefined) {
        opened.push(spec.name);
      }
    }
    if (opened.length === 0) {
      if (serviceName === undefined) {
        sessions.delete(target.id);
        await deps.writePortsFile(target.folder, {}, deps.now());
      }
      return fail("nothing-to-do", "尚未啟動");
    }

    if (active.length > 0) {
      const result = await deps.stopPorts(active.map((item) => item.port));
      if (result.code !== 0) {
        const detail = result.stderr.trim().slice(0, ERROR_TEXT_MAX) || "未知錯誤";
        log("warn", `無法結束 ${target.label}：${detail}`);
        return fail("failed", `無法結束：${detail}`);
      }
    }

    // 程序已停止，狀態先清掉；分頁關不掉時不能讓畫面還以為服務在跑。
    for (const name of opened) {
      delete session.ports[name];
      delete session.startedAt[name];
    }
    if (Object.keys(session.ports).length === 0 && Object.keys(session.startedAt).length === 0) {
      sessions.delete(target.id);
    } else {
      sessions.set(target.id, session);
    }

    const known: Record<string, PortsFileService> = {};
    for (const spec of manifest.services) {
      const port = session.ports[spec.name];
      if (spec.port && port !== undefined) {
        known[spec.name] = { role: spec.role, port };
      }
    }
    await deps.writePortsFile(target.folder, known, deps.now());

    let tabFailure: RunActionResult | null = null;
    if (deps.itermAvailable()) {
      const closed = await deps.closeTabs(opened.map((name) => runSessionName(target.id, name)));
      if (closed.code !== 0) {
        if (AUTOMATION_DENIED.test(closed.stderr)) {
          tabFailure = fail("permission-denied", "服務已結束，但 macOS 沒有允許 GitNRun 控制 iTerm2，分頁沒有關閉。請到「系統設定 → 隱私權與安全性 → 自動化」開啟後再試一次。");
        } else {
          const detail = closed.stderr.trim().slice(0, ERROR_TEXT_MAX) || "未知錯誤";
          log("warn", `已結束 ${target.label}，但無法關閉 iTerm2 分頁：${detail}`);
          tabFailure = fail("failed", `服務已結束，但無法關閉 iTerm2 分頁：${detail}`);
        }
      }
    }

    // 手機服務結束時連模擬器一起關；分頁關不掉也照關，兩邊的失敗各自記錄。
    const simulators = await closeSimulators(target, opened);
    if (tabFailure !== null) return tabFailure;
    if (simulators.failure !== null) return simulators.failure;

    const simulatorNote = simulators.platforms.map((platform) => `，並關閉 ${SIMULATOR_LABEL[platform]} 模擬器`).join("");
    log("info", `已結束 ${target.label}：${opened.join("、")}${simulatorNote}`);
    return { ok: true, message: `已結束 ${opened.length} 個服務並關閉終端機分頁：${opened.join("、")}${simulatorNote}` };
  };

  const start = async (
    target: Target,
    loaded: Extract<LoadedManifest, { status: "ok" }>,
    selection: RunStartSelection,
    restart = false
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
    const session = sessions.get(target.id) ?? { ports: {}, startedAt: {} };
    const reuse: Record<string, number> = {};
    const skip = new Set<string>();
    for (const spec of manifest.services) {
      if (!spec.port) continue;
      const { state, port } = await serviceState(session, spec.name);
      if (state !== "stopped" && port !== null) {
        reuse[spec.name] = port;
        if (selected.some((item) => item.name === spec.name)) skip.add(spec.name);
      }
    }

    if (!restart && selected.every((item) => skip.has(item.name))) {
      const urls = selected.map((item) => reuse[item.name]).filter((port): port is number => port !== undefined).map(urlForPort);
      return { ok: true, message: `已經在執行中：${urls.join("、")}` };
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

    const fresh = await deps.allocatePorts(countFreshPorts(manifest, reuse));
    const plan = planStart(manifest, selection, reuse, restart ? new Set<string>() : skip, fresh);
    const tabs: ItermTab[] = plan.starts.map((item) => ({
      dir: serviceDirectory(target.folder, item.cwd),
      name: runSessionName(target.id, item.name),
      command: restart && item.port !== null && reuse[item.name] !== undefined ? `${stopListeningCommand(item.port)} ${item.commandLine}` : item.commandLine
    }));

    const result = await deps.launchTabs(tabs);
    if (result.code !== 0) {
      if (AUTOMATION_DENIED.test(result.stderr)) {
        return fail("permission-denied", "macOS 沒有允許 devRun 控制 iTerm2。請到「系統設定 → 隱私權與安全性 → 自動化」開啟後再試一次。");
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
      next.ports[name] = port;
    }
    sessions.set(target.id, next);

    const known: Record<string, PortsFileService> = {};
    for (const spec of manifest.services) {
      const port = next.ports[spec.name];
      if (spec.port && port !== undefined && (plan.starts.some((item) => item.name === spec.name) || reuse[spec.name] !== undefined)) {
        known[spec.name] = { role: spec.role, port };
      }
    }
    await deps.writePortsFile(target.folder, known, now);

    const names = plan.starts.map((item) => item.name);
    log("info", `${restart ? "已在 iTerm2 重新啟動" : "已在 iTerm2 啟動"} ${target.label}：${names.join("、")}`, {
      commands: tabs.map((item) => ({ service: item.name, commandLine: item.command }))
    });
    return { ok: true, message: `已在 iTerm2 ${restart ? "重新開啟" : "開啟"} ${names.length} 個分頁：${names.join("、")}` };
  };

  return {
    async overview() {
      const itermAvailable = deps.itermAvailable();
      return {
        iterm: itermAvailable,
        vaultAvailable: deps.vault.isAvailable(),
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
      const loaded = await deps.loadManifest(target.folder);
      if (loaded.status === "missing") {
        return fail("no-manifest", "找不到可啟動服務");
      }
      if (loaded.status === "invalid") {
        return fail("invalid-manifest", `描述檔有誤：${loaded.errors[0] ?? "未知原因"}`);
      }
      if (action.scope === "project") {
        return stop(target, loaded.manifest);
      }
      if (action.action === "web") {
        return openWeb(target, loaded.manifest, action.service);
      }
      if (action.action === "stop") {
        return stop(target, loaded.manifest, action.service);
      }
      return start(target, loaded, { service: action.service }, action.action === "restart");
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
      // 資料夾的識別號之後會被新加入的資料夾沿用，帳號與密碼不能留給下一個人。
      setRunAccount(db, targetId, "");
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
      if (!findTarget(targetId)) {
        throw new UserFacingError("找不到這個專案");
      }
      try {
        await deps.vault.useSecret(passcodeSecretName(targetId), (secret) => deps.copySecret(secret));
      } catch (error) {
        if (error instanceof SecretMissingError) throw new UserFacingError("還沒有設定密碼");
        if (error instanceof SecretUnreadableError) throw new UserFacingError("密碼無法解密，請重新輸入");
        throw error;
      }
    }
  };
};
