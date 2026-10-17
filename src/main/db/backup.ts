import { chmodSync, existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateRuleInput, type RuleInput } from "@shared/rules";
import { ensureSecureDirectory, inTransaction, type Db } from "@main/db/database";
import { listRules } from "@main/db/rules-repo";

/**
 * 設定備份（JSON）：規則、終端機映射、分支範本、專案設定、一般設定。
 * 絕不包含 api_keys 表或任何密鑰；換機還原後需重新輸入所有金鑰。
 */

export const BACKUP_SCHEMA_VERSION = 1;
export const BACKUP_KEEP = 10;
export const MAX_BACKUP_BYTES = 5 * 1024 * 1024;

const PROJECT_MODES = ["poll", "webhook", "both"] as const;
type ProjectMode = (typeof PROJECT_MODES)[number];

export interface BackupSetting {
  key: string;
  value: unknown;
}

export interface BackupProject {
  owner: string;
  repo: string;
  name: string;
  localPath: string | null;
  defaultBranch: string | null;
  branchFilter: string[];
  pollIntervalSec: number;
  mode: ProjectMode;
  aiEnabled: boolean;
  enabled: boolean;
}

export interface BackupBranchRule {
  /** "owner/repo"；null 代表全域預設範本。 */
  projectKey: string | null;
  template: string;
  versionSource: string;
  exempt: string[];
}

export type BackupRule = RuleInput;

export interface BackupTerminalMapping {
  pathPattern: string;
  command: string;
  recursive: boolean;
  terminalApp: string;
}

export interface ConfigBackup {
  schemaVersion: number;
  exportedAt: number;
  settings: BackupSetting[];
  projects: BackupProject[];
  branchRules: BackupBranchRule[];
  rules: BackupRule[];
  terminalMappings: BackupTerminalMapping[];
}

// 設定 key 長得像密鑰的一律不進備份（也不從備份匯入）。
// run.trusted 是「這台機器上你確認過的啟動指令」，換機或還原備份時必須重新確認，所以一併排除。
// run.accounts 是 dev 通關帳號，帳號也不進備份（Debug 密碼只在專案環境檔，GitNRun 不保存）。
const SECRET_KEY_PATTERN = /secret|token|password|passwd|api[_.-]?key|credential|private|^run\.(?:trusted|accounts)/i;
export const isSecretLikeSettingKey = (key: string): boolean => SECRET_KEY_PATTERN.test(key);

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string") {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

export const exportConfig = (db: Db, now: number = Date.now()): ConfigBackup => {
  const projectRows = db.prepare("SELECT * FROM projects ORDER BY owner, repo").all();
  const projectKeyById = new Map<number, string>(
    projectRows.map((row) => [Number(row.id), `${String(row.owner)}/${String(row.repo)}`])
  );

  const settings: BackupSetting[] = db
    .prepare("SELECT key, value FROM settings ORDER BY key")
    .all()
    .filter((row) => !isSecretLikeSettingKey(String(row.key)))
    .map((row) => ({ key: String(row.key), value: parseJson<unknown>(row.value, null) }));

  const projects: BackupProject[] = projectRows.map((row) => ({
    owner: String(row.owner),
    repo: String(row.repo),
    name: String(row.name),
    localPath: row.local_path === null ? null : String(row.local_path),
    defaultBranch: row.default_branch === null ? null : String(row.default_branch),
    branchFilter: parseJson<string[]>(row.branch_filter_json, ["*"]),
    pollIntervalSec: Number(row.poll_interval_sec),
    mode: row.mode as ProjectMode,
    aiEnabled: Number(row.ai_enabled) === 1,
    enabled: Number(row.enabled) === 1
  }));

  const branchRules: BackupBranchRule[] = db
    .prepare("SELECT * FROM branch_rules ORDER BY project_id")
    .all()
    .flatMap((row) => {
      const projectId = Number(row.project_id);
      const projectKey = projectId === 0 ? null : (projectKeyById.get(projectId) ?? undefined);
      if (projectKey === undefined) {
        return [];
      }
      return [
        {
          projectKey,
          template: String(row.template),
          versionSource: String(row.version_source),
          exempt: parseJson<string[]>(row.exempt_json, [])
        }
      ];
    });

  const rules: BackupRule[] = listRules(db).map(({ id: _id, createdAt: _created, updatedAt: _updated, ...input }) => input);

  const terminalMappings: BackupTerminalMapping[] = db
    .prepare("SELECT * FROM terminal_mappings ORDER BY path_pattern")
    .all()
    .map((row) => ({
      pathPattern: String(row.path_pattern),
      command: String(row.command),
      recursive: Number(row.recursive) === 1,
      terminalApp: String(row.terminal_app)
    }));

  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: now,
    settings,
    projects,
    branchRules,
    rules,
    terminalMappings
  };
};

// ---------------------------------------------------------------------------
// 驗證（匯入）
// ---------------------------------------------------------------------------

export class BackupValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`invalid backup: ${issues.join("; ")}`);
    this.name = "BackupValidationError";
    this.issues = issues;
  }
}

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "exportedAt",
  "settings",
  "projects",
  "branchRules",
  "rules",
  "terminalMappings"
]);

const MAX_ITEMS = 1000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const REPO_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

class Collector {
  readonly issues: string[] = [];

  fail(path: string, message: string): void {
    if (this.issues.length < 20) {
      this.issues.push(`${path}: ${message}`);
    }
  }

  string(value: unknown, path: string, max: number, options: { empty?: boolean; control?: boolean } = {}): string {
    if (typeof value !== "string" || value.length > max || (!options.empty && value.length === 0)) {
      this.fail(path, "expected a non-empty string within the length limit");
      return "";
    }
    if (!options.control && CONTROL_CHARACTERS.test(value)) {
      this.fail(path, "control characters are not allowed");
      return "";
    }
    return value;
  }

  nullableString(value: unknown, path: string, max: number): string | null {
    return value === null ? null : this.string(value, path, max);
  }

  boolean(value: unknown, path: string): boolean {
    if (typeof value !== "boolean") {
      this.fail(path, "expected a boolean");
      return false;
    }
    return value;
  }

  integer(value: unknown, path: string, min: number, max: number): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
      this.fail(path, `expected an integer between ${min} and ${max}`);
      return min;
    }
    return value;
  }

  array(value: unknown, path: string): unknown[] {
    if (!Array.isArray(value) || value.length > MAX_ITEMS) {
      this.fail(path, `expected an array of at most ${MAX_ITEMS} items`);
      return [];
    }
    return value;
  }

  stringArray(value: unknown, path: string): string[] {
    return this.array(value, path).map((item, index) => this.string(item, `${path}[${index}]`, 200));
  }
}

export const parseBackup = (raw: unknown): ConfigBackup => {
  const c = new Collector();
  if (!isRecord(raw)) {
    throw new BackupValidationError(["backup must be a JSON object"]);
  }

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      c.fail(key, "unknown field (backups never carry secrets or extra data)");
    }
  }

  if (typeof raw.schemaVersion !== "number" || !Number.isSafeInteger(raw.schemaVersion)) {
    c.fail("schemaVersion", "expected an integer");
  } else if (raw.schemaVersion > BACKUP_SCHEMA_VERSION) {
    c.fail("schemaVersion", `backup is from a newer app version (v${raw.schemaVersion})`);
  } else if (raw.schemaVersion < 1) {
    c.fail("schemaVersion", "unsupported version");
  }

  const exportedAt = c.integer(raw.exportedAt, "exportedAt", 0, Number.MAX_SAFE_INTEGER);

  const settings: BackupSetting[] = c.array(raw.settings, "settings").flatMap((item, index) => {
    const path = `settings[${index}]`;
    if (!isRecord(item)) {
      c.fail(path, "expected an object");
      return [];
    }
    const key = c.string(item.key, `${path}.key`, 200);
    if (key && isSecretLikeSettingKey(key)) {
      c.fail(`${path}.key`, "secret-like settings are not allowed in backups");
      return [];
    }
    return key ? [{ key, value: item.value ?? null }] : [];
  });

  const projects: BackupProject[] = c.array(raw.projects, "projects").flatMap((item, index) => {
    const path = `projects[${index}]`;
    if (!isRecord(item)) {
      c.fail(path, "expected an object");
      return [];
    }
    const owner = c.string(item.owner, `${path}.owner`, 100);
    const repo = c.string(item.repo, `${path}.repo`, 100);
    for (const [label, value] of [["owner", owner], ["repo", repo]] as const) {
      if (value && (!REPO_NAME.test(value) || value === "." || value === "..")) {
        c.fail(`${path}.${label}`, "not a valid GitHub name");
      }
    }
    const mode = PROJECT_MODES.find((candidate) => candidate === item.mode);
    if (!mode) {
      c.fail(`${path}.mode`, "expected poll, webhook or both");
    }
    return [
      {
        owner,
        repo,
        name: c.string(item.name, `${path}.name`, 200),
        localPath: c.nullableString(item.localPath, `${path}.localPath`, 4096),
        defaultBranch: c.nullableString(item.defaultBranch, `${path}.defaultBranch`, 200),
        branchFilter: c.stringArray(item.branchFilter, `${path}.branchFilter`),
        pollIntervalSec: c.integer(item.pollIntervalSec, `${path}.pollIntervalSec`, 15, 3600),
        mode: mode ?? "poll",
        aiEnabled: c.boolean(item.aiEnabled, `${path}.aiEnabled`),
        enabled: c.boolean(item.enabled, `${path}.enabled`)
      }
    ];
  });

  const branchRules: BackupBranchRule[] = c.array(raw.branchRules, "branchRules").flatMap((item, index) => {
    const path = `branchRules[${index}]`;
    if (!isRecord(item)) {
      c.fail(path, "expected an object");
      return [];
    }
    return [
      {
        projectKey: c.nullableString(item.projectKey, `${path}.projectKey`, 201),
        template: c.string(item.template, `${path}.template`, 200),
        versionSource: c.string(item.versionSource, `${path}.versionSource`, 200),
        exempt: c.stringArray(item.exempt, `${path}.exempt`)
      }
    ];
  });

  // 規則用與 IPC 儲存相同的嚴格驗證：條件、動作的類型與欄位都檢查，清單外的類型一律拒絕。
  const rules: BackupRule[] = c.array(raw.rules, "rules").flatMap((item, index) => {
    const result = validateRuleInput(item, `rules[${index}]`);
    if (!result.ok) {
      for (const error of result.errors) {
        c.fail("rules", error);
      }
      return [];
    }
    // 不信任備份檔對「免確認」的設定；匯入時一律重設，見 importConfig。
    return [result.value];
  });

  const terminalMappings: BackupTerminalMapping[] = c
    .array(raw.terminalMappings, "terminalMappings")
    .flatMap((item, index) => {
      const path = `terminalMappings[${index}]`;
      if (!isRecord(item)) {
        c.fail(path, "expected an object");
        return [];
      }
      return [
        {
          pathPattern: c.string(item.pathPattern, `${path}.pathPattern`, 4096),
          command: c.string(item.command, `${path}.command`, 8192, { empty: true, control: true }),
          recursive: c.boolean(item.recursive, `${path}.recursive`),
          terminalApp: c.string(item.terminalApp, `${path}.terminalApp`, 100)
        }
      ];
    });

  if (c.issues.length > 0) {
    throw new BackupValidationError(c.issues);
  }

  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt,
    settings,
    projects,
    branchRules,
    rules,
    terminalMappings
  };
};

export interface ImportResult {
  settings: number;
  projects: number;
  branchRules: number;
  rules: number;
  terminalMappings: number;
}

/**
 * 還原設定：專案以 owner/repo 為鍵 upsert（不刪除，避免 CASCADE 清掉事件歷史），
 * 規則、終端機映射、分支範本整批取代。為避免來路不明的備份檔悄悄關閉確認閘門，
 * 匯入的規則一律把「免確認」重設為關閉，需使用者重新開啟。
 */
export const importConfig = (db: Db, raw: unknown, now: number = Date.now()): ImportResult => {
  const backup = parseBackup(raw);

  return inTransaction(db, () => {
    const upsertSetting = db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    );
    for (const setting of backup.settings) {
      upsertSetting.run(setting.key, JSON.stringify(setting.value), now);
    }

    const upsertProject = db.prepare(
      `INSERT INTO projects (name, owner, repo, local_path, default_branch, branch_filter_json,
         poll_interval_sec, mode, ai_enabled, enabled, path_exists, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner, repo) DO UPDATE SET
         name = excluded.name, local_path = excluded.local_path, default_branch = excluded.default_branch,
         branch_filter_json = excluded.branch_filter_json, poll_interval_sec = excluded.poll_interval_sec,
         mode = excluded.mode, ai_enabled = excluded.ai_enabled, enabled = excluded.enabled, path_exists = excluded.path_exists`
    );
    for (const project of backup.projects) {
      // path_exists 是磁碟實況，不是可攜設定；備份檔不存這個欄位，還原時用這台機器當下的磁碟狀態重新檢查。
      upsertProject.run(
        project.name,
        project.owner,
        project.repo,
        project.localPath,
        project.defaultBranch,
        JSON.stringify(project.branchFilter),
        project.pollIntervalSec,
        project.mode,
        project.aiEnabled ? 1 : 0,
        project.enabled ? 1 : 0,
        project.localPath !== null && existsSync(project.localPath) ? 1 : 0,
        now
      );
    }

    const projectIdByKey = new Map<string, number>(
      db
        .prepare("SELECT id, owner, repo FROM projects")
        .all()
        .map((row) => [`${String(row.owner)}/${String(row.repo)}`, Number(row.id)])
    );

    db.exec("DELETE FROM branch_rules");
    const insertBranchRule = db.prepare(
      `INSERT INTO branch_rules (project_id, template, version_source, exempt_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    let branchRuleCount = 0;
    for (const branchRule of backup.branchRules) {
      const projectId = branchRule.projectKey === null ? 0 : projectIdByKey.get(branchRule.projectKey);
      if (projectId === undefined) {
        continue;
      }
      insertBranchRule.run(
        projectId,
        branchRule.template,
        branchRule.versionSource,
        JSON.stringify(branchRule.exempt),
        now,
        now
      );
      branchRuleCount += 1;
    }

    db.exec("DELETE FROM rules");
    const insertRule = db.prepare(
      `INSERT INTO rules (name, enabled, priority, match_mode, conditions_json, actions_json,
         cooldown_sec, skip_confirm, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    );
    for (const rule of backup.rules) {
      insertRule.run(
        rule.name,
        rule.enabled ? 1 : 0,
        rule.priority,
        rule.matchMode,
        JSON.stringify(rule.conditions),
        JSON.stringify(rule.actions),
        rule.cooldownSec,
        now,
        now
      );
    }

    db.exec("DELETE FROM terminal_mappings");
    const insertMapping = db.prepare(
      `INSERT INTO terminal_mappings (path_pattern, command, recursive, terminal_app, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(path_pattern) DO UPDATE SET
         command = excluded.command, recursive = excluded.recursive,
         terminal_app = excluded.terminal_app, updated_at = excluded.updated_at`
    );
    for (const mapping of backup.terminalMappings) {
      insertMapping.run(mapping.pathPattern, mapping.command, mapping.recursive ? 1 : 0, mapping.terminalApp, now, now);
    }

    return {
      settings: backup.settings.length,
      projects: backup.projects.length,
      branchRules: branchRuleCount,
      rules: backup.rules.length,
      terminalMappings: backup.terminalMappings.length
    };
  });
};

// ---------------------------------------------------------------------------
// 檔案：寫入、輪替、讀取
// ---------------------------------------------------------------------------

const BACKUP_FILE = /^config-\d{8}-\d{6}-\d{3}\.json$/;

const pad = (value: number, width: number): string => String(value).padStart(width, "0");

export const backupFileName = (timestamp: number): string => {
  const d = new Date(timestamp);
  return (
    `config-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCDate(), 2)}` +
    `-${pad(d.getUTCHours(), 2)}${pad(d.getUTCMinutes(), 2)}${pad(d.getUTCSeconds(), 2)}-${pad(d.getUTCMilliseconds(), 3)}.json`
  );
};

/** 由新到舊。 */
export const listBackups = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => BACKUP_FILE.test(name))
        .sort()
        .reverse()
    : [];

/** 只刪備份資料夾裡檔名符合本程式格式的檔案，其他檔案一律不碰；回傳實際刪掉的檔名。 */
export const deleteBackups = (dir: string, names: readonly string[]): string[] => {
  const present = new Set(listBackups(dir));
  const removed: string[] = [];
  for (const name of names) {
    if (present.has(name)) {
      unlinkSync(join(dir, name));
      removed.push(name);
    }
  }
  return removed;
};

// 鍵排序後序列化，比對時不受物件欄位順序影響。
const comparable = (backup: ConfigBackup): string =>
  JSON.stringify({ ...backup, exportedAt: 0 }, (_key, value: unknown) =>
    isRecord(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : value
  );

export interface WriteBackupResult {
  written: boolean;
  path: string | null;
  removed: string[];
}

export interface WriteBackupOptions {
  keep?: number;
  now?: number;
}

/**
 * 寫入一份備份並輪替。內容與最新一份相同（忽略時間戳）就不重複寫，
 * 避免頻繁重啟把較早、有意義的備份擠出保留名額。
 */
export const writeBackup = (dir: string, backup: ConfigBackup, options: WriteBackupOptions = {}): WriteBackupResult => {
  const keep = options.keep ?? BACKUP_KEEP;
  const now = options.now ?? Date.now();
  ensureSecureDirectory(dir);

  const [latest] = listBackups(dir);
  if (latest) {
    try {
      const previous = parseBackup(JSON.parse(readFileSync(join(dir, latest), "utf8")));
      if (comparable(previous) === comparable(backup)) {
        return { written: false, path: null, removed: [] };
      }
    } catch {
      // 最新一份損毀就當作不同，照常寫新的。
    }
  }

  const target = join(dir, backupFileName(now));
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, JSON.stringify(backup, null, 2), { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, target);

  const removed = listBackups(dir).slice(keep);
  for (const name of removed) {
    unlinkSync(join(dir, name));
  }
  return { written: true, path: target, removed };
};

/** 讀取備份檔並回傳未驗證的 JSON；超過大小上限直接拒絕。 */
export const readBackupFile = (path: string): unknown => {
  if (statSync(path).size > MAX_BACKUP_BYTES) {
    throw new BackupValidationError([`file is larger than ${MAX_BACKUP_BYTES} bytes`]);
  }
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
};
