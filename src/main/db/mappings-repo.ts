import type { TerminalMapping, TerminalMappingInput } from "@shared/launcher";
import type { Db } from "@main/db/database";

type Row = Record<string, unknown>;

const rowToMapping = (row: Row): TerminalMapping => ({
  id: Number(row.id),
  pathPattern: String(row.path_pattern),
  command: String(row.command),
  recursive: Number(row.recursive) === 1,
  terminalApp: String(row.terminal_app)
});

export const listMappings = (db: Db): TerminalMapping[] =>
  db.prepare("SELECT * FROM terminal_mappings ORDER BY id").all().map(rowToMapping);

export const getMapping = (db: Db, id: number): TerminalMapping | null => {
  const row = db.prepare("SELECT * FROM terminal_mappings WHERE id = ?").get(id);
  return row ? rowToMapping(row) : null;
};

/** 同一個路徑樣式只有一條映射；再存一次就是更新。 */
export const saveMapping = (db: Db, input: TerminalMappingInput, now: number = Date.now()): TerminalMapping => {
  db.prepare(
    `INSERT INTO terminal_mappings (path_pattern, command, recursive, terminal_app, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path_pattern) DO UPDATE SET
       command = excluded.command, recursive = excluded.recursive,
       terminal_app = excluded.terminal_app, updated_at = excluded.updated_at`
  ).run(input.pathPattern, input.command, input.recursive ? 1 : 0, input.terminalApp, now, now);
  const row = db.prepare("SELECT * FROM terminal_mappings WHERE path_pattern = ?").get(input.pathPattern);
  return rowToMapping(row as Row);
};

export const deleteMapping = (db: Db, id: number): boolean =>
  Number(db.prepare("DELETE FROM terminal_mappings WHERE id = ?").run(id).changes) > 0;
