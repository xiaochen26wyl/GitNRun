import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  name: string;
  sql: string;
  /** SQL 做不到的資料回填；在同一筆交易內、ALTER 執行後才跑。 */
  postMigrate?: (db: DatabaseSync) => void;
}

/**
 * v1：規格要求的八張表（projects、webhooks、push_events、rules、rule_executions、
 * terminal_mappings、api_keys、logs），加上規格漏列但必需的
 * settings、branch_rules、ai_calls、poll_state、poll_meta。
 *
 * 時間欄位一律是 epoch ms 整數。api_keys 只存密文與遮罩提示，絕不存明文。
 */
const SCHEMA_V1 = `
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE projects (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,
  owner              TEXT NOT NULL,
  repo               TEXT NOT NULL,
  local_path         TEXT,
  default_branch     TEXT,
  branch_filter_json TEXT NOT NULL DEFAULT '["*"]',
  poll_interval_sec  INTEGER NOT NULL DEFAULT 30,
  mode               TEXT NOT NULL DEFAULT 'poll' CHECK (mode IN ('poll', 'webhook', 'both')),
  ai_enabled         INTEGER NOT NULL DEFAULT 0,
  enabled            INTEGER NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL,
  UNIQUE (owner, repo)
);

CREATE TABLE webhooks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  enabled          INTEGER NOT NULL DEFAULT 0,
  secret_ref       TEXT NOT NULL,
  last_received_at INTEGER,
  created_at       INTEGER NOT NULL
);

CREATE TABLE push_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_type       TEXT NOT NULL DEFAULT 'push' CHECK (event_type IN ('push', 'create', 'delete')),
  ref              TEXT NOT NULL,
  branch           TEXT NOT NULL,
  before_sha       TEXT,
  after_sha        TEXT NOT NULL,
  pusher           TEXT,
  pusher_inferred  INTEGER NOT NULL DEFAULT 0,
  head_message     TEXT NOT NULL DEFAULT '',
  commits_json     TEXT NOT NULL DEFAULT '[]',
  files_json       TEXT NOT NULL DEFAULT '[]',
  file_count       INTEGER NOT NULL DEFAULT 0,
  branch_violation INTEGER NOT NULL DEFAULT 0,
  source           TEXT NOT NULL CHECK (source IN ('poll', 'webhook')),
  occurred_at      INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  -- 冪等鍵：輪詢與 Webhook 兩種來源寫進同一張表也不會重複。
  UNIQUE (project_id, ref, after_sha, event_type)
);
CREATE INDEX idx_push_events_project_time ON push_events (project_id, occurred_at DESC);
CREATE INDEX idx_push_events_time ON push_events (occurred_at DESC);
CREATE INDEX idx_push_events_branch ON push_events (branch);
CREATE INDEX idx_push_events_pusher ON push_events (pusher);

CREATE TABLE rules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  priority        INTEGER NOT NULL DEFAULT 100,
  match_mode      TEXT NOT NULL DEFAULT 'all' CHECK (match_mode IN ('all', 'any')),
  conditions_json TEXT NOT NULL DEFAULT '[]',
  actions_json    TEXT NOT NULL DEFAULT '[]',
  cooldown_sec    INTEGER NOT NULL DEFAULT 0,
  skip_confirm    INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE rule_executions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id     INTEGER REFERENCES rules(id) ON DELETE SET NULL,
  rule_name   TEXT NOT NULL,
  event_id    INTEGER NOT NULL REFERENCES push_events(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,
  dry_run     INTEGER NOT NULL DEFAULT 0,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  detail_json TEXT
);
CREATE INDEX idx_rule_executions_event ON rule_executions (event_id);
CREATE INDEX idx_rule_executions_started ON rule_executions (started_at DESC);

CREATE TABLE terminal_mappings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  path_pattern TEXT NOT NULL UNIQUE,
  command      TEXT NOT NULL DEFAULT '',
  recursive    INTEGER NOT NULL DEFAULT 0,
  terminal_app TEXT NOT NULL DEFAULT 'terminal',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE api_keys (
  name       TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  hint       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  category    TEXT NOT NULL,
  level       TEXT NOT NULL DEFAULT 'info',
  message     TEXT NOT NULL,
  detail_json TEXT
);
CREATE INDEX idx_logs_ts ON logs (ts DESC);
CREATE INDEX idx_logs_category_ts ON logs (category, ts DESC);

-- project_id = 0 代表全域預設範本。
CREATE TABLE branch_rules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     INTEGER NOT NULL UNIQUE,
  template       TEXT NOT NULL,
  version_source TEXT NOT NULL DEFAULT 'package.json',
  exempt_json    TEXT NOT NULL DEFAULT '["main","master","develop","release/*"]',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE TRIGGER trg_projects_delete_branch_rules
AFTER DELETE ON projects
BEGIN
  DELETE FROM branch_rules WHERE project_id = OLD.id;
END;

CREATE TABLE ai_calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  project_id    INTEGER,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  purpose       TEXT NOT NULL,
  input_hash    TEXT NOT NULL,
  cache_hit     INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  status        TEXT NOT NULL,
  response_text TEXT
);
CREATE INDEX idx_ai_calls_ts ON ai_calls (ts DESC);
CREATE INDEX idx_ai_calls_cache ON ai_calls (input_hash, model, ts DESC);

CREATE TABLE poll_state (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  branch     TEXT NOT NULL,
  head_sha   TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, branch)
);

CREATE TABLE poll_meta (
  project_id      INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  etag            TEXT,
  baseline_done   INTEGER NOT NULL DEFAULT 0,
  last_polled_at  INTEGER,
  last_error      TEXT
);
`;

/**
 * v2：規則自己造成的推送。規則執行 push（或建立並推送分支）後，新的 head SHA 會在下一輪
 * 輪詢被當成新事件，若條件相符就會再次觸發同一條規則；記下這些 SHA，讓規則忽略自己造成的事件。
 */
const SCHEMA_V2 = `
CREATE TABLE rule_self_events (
  rule_id    INTEGER NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  sha        TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (rule_id, sha)
);
CREATE INDEX idx_rule_self_events_created ON rule_self_events (created_at);
`;

/**
 * v3：Webhook 送達記錄。GitHub 在逾時或重試時會把同一次送達（X-GitHub-Delivery）再送一遍，
 * 記下已經處理過的送達 ID，重送就不會重複處理。
 */
const SCHEMA_V3 = `
CREATE TABLE webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  received_at INTEGER NOT NULL
);
CREATE INDEX idx_webhook_deliveries_received ON webhook_deliveries (received_at);
`;

/**
 * v4：專案本機路徑是否真的存在於磁碟。只在新增／編輯專案（localPath 有變動）時重新檢查，
 * 不是每次顯示都重新掃；既有專案在這次 migration 當下批次回填一次正確值。
 */
const SCHEMA_V4 = `
ALTER TABLE projects ADD COLUMN path_exists INTEGER NOT NULL DEFAULT 0;
`;

const backfillPathExists = (db: DatabaseSync): void => {
  const rows = db.prepare("SELECT id, local_path FROM projects").all();
  const update = db.prepare("UPDATE projects SET path_exists = ? WHERE id = ?");
  for (const row of rows) {
    const localPath = row.local_path === null ? null : String(row.local_path);
    update.run(localPath !== null && existsSync(localPath) ? 1 : 0, Number(row.id));
  }
};

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "initial schema", sql: SCHEMA_V1 },
  { version: 2, name: "rule self events", sql: SCHEMA_V2 },
  { version: 3, name: "webhook deliveries", sql: SCHEMA_V3 },
  { version: 4, name: "project path existence", sql: SCHEMA_V4, postMigrate: backfillPathExists }
];

export const LATEST_SCHEMA_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

export class SchemaTooNewError extends Error {
  constructor(found: number, supported: number) {
    super(`database schema v${found} is newer than this app supports (v${supported})`);
    this.name = "SchemaTooNewError";
  }
}

export const getSchemaVersion = (db: DatabaseSync): number => {
  const row = db.prepare("PRAGMA user_version").get();
  return Number(row?.user_version ?? 0);
};

export interface MigrationResult {
  from: number;
  to: number;
}

/** 依 user_version 做有序遷移；每個遷移各自在交易內，失敗整段回滾。 */
export const migrate = (db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): MigrationResult => {
  const from = getSchemaVersion(db);
  const latest = migrations[migrations.length - 1]?.version ?? 0;
  if (from > latest) {
    throw new SchemaTooNewError(from, latest);
  }

  let current = from;
  for (const migration of migrations) {
    if (migration.version <= current) {
      continue;
    }
    if (!Number.isSafeInteger(migration.version) || migration.version !== current + 1) {
      throw new Error(`migration ${migration.version} is not sequential after v${current}`);
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      migration.postMigrate?.(db);
      // PRAGMA 不能用參數綁定；版本號已驗證為安全整數。
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    current = migration.version;
  }

  return { from, to: current };
};
