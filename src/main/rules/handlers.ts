import type { DryRunReport, RuleExecution, RulePreviewReport } from "@shared/rule-runs";
import { validateRuleInput, type Rule, type RuleInput } from "@shared/rules";
import type { Db } from "@main/db/database";
import { getEvent } from "@main/db/events-repo";
import { getProject } from "@main/db/projects-repo";
import { listExecutions } from "@main/db/rule-executions-repo";
import {
  createRule,
  deleteRule,
  getRule,
  listRules,
  reorderRules,
  setRuleEnabled,
  updateRule
} from "@main/db/rules-repo";
import { UserFacingError } from "@main/errors";
import type { RuleEngine } from "@main/rules/engine";
import type { Vault } from "@main/vault/vault";

/** 規則管理的處理邏輯（與 Electron 無關，可直接單元測試）。 */

export const RULES_FILE_FORMAT = "gitnrun-rules";
export const RULES_FILE_VERSION = 1;
export const MAX_RULES_FILE_BYTES = 1024 * 1024;
const MAX_IMPORTED_RULES = 200;

export interface ImportRulesResult {
  imported: number;
  /** 名稱與既有規則重複而被改名的數量。 */
  renamed: number;
}

export interface RulesHandlerDeps {
  db: Db;
  engine: Pick<RuleEngine, "dryRun" | "previewMatches">;
  vault: Pick<Vault, "overview" | "delete">;
  onConfigChanged: () => void;
}

export interface RulesHandlers {
  list(): Rule[];
  create(raw: Record<string, unknown>): Rule;
  update(id: number, raw: Record<string, unknown>): Rule;
  remove(id: number): void;
  setEnabled(id: number, enabled: boolean): Rule;
  reorder(orderedIds: number[]): Rule[];
  preview(raw: Record<string, unknown>): RulePreviewReport;
  dryRun(raw: Record<string, unknown>, eventId: number): Promise<DryRunReport>;
  executions(ruleId?: number): RuleExecution[];
  exportText(): string;
  importText(text: string): ImportRulesResult;
}

const toRuleInput = (rule: Rule): RuleInput => {
  const { id: _id, createdAt: _created, updatedAt: _updated, ...input } = rule;
  return input;
};

export const createRulesHandlers = (deps: RulesHandlerDeps): RulesHandlers => {
  const { db } = deps;

  const validated = (raw: unknown): RuleInput => {
    const result = validateRuleInput(raw);
    if (!result.ok) {
      throw new UserFacingError(result.errors.join("\n"));
    }
    return result.value;
  };

  const requireRule = (id: number): Rule => {
    const rule = getRule(db, id);
    if (!rule) {
      throw new UserFacingError("找不到這條規則");
    }
    return rule;
  };

  /** 規則不再使用的敏感環境變數（改掉名稱、刪掉動作、刪掉規則）一併從保險庫清掉。 */
  const pruneRuleSecrets = (ruleId: number, keep: ReadonlySet<string>): void => {
    const prefix = `env.${ruleId}.`;
    for (const secret of deps.vault.overview().secrets) {
      if (secret.name.startsWith(prefix) && !keep.has(secret.name)) {
        deps.vault.delete(secret.name);
      }
    }
  };

  const secretNamesOf = (rule: RuleInput, ruleId: number): Set<string> =>
    new Set(
      rule.actions.flatMap((action) =>
        action.type === "shell" ? action.secretEnvNames.map((name) => `env.${ruleId}.${name}`) : []
      )
    );

  const uniqueName = (name: string, taken: Set<string>): string => {
    if (!taken.has(name)) {
      return name;
    }
    for (let suffix = 2; ; suffix += 1) {
      const candidate = `${name} (${suffix})`;
      if (!taken.has(candidate)) {
        return candidate;
      }
    }
  };

  return {
    list: () => listRules(db),

    create(raw) {
      const rule = createRule(db, validated(raw));
      deps.onConfigChanged();
      return rule;
    },

    update(id, raw) {
      requireRule(id);
      const input = validated(raw);
      const updated = updateRule(db, id, input);
      if (!updated) {
        throw new UserFacingError("找不到這條規則");
      }
      pruneRuleSecrets(id, secretNamesOf(input, id));
      deps.onConfigChanged();
      return updated;
    },

    remove(id) {
      if (deleteRule(db, id)) {
        pruneRuleSecrets(id, new Set());
        deps.onConfigChanged();
      }
    },

    setEnabled(id, enabled) {
      requireRule(id);
      setRuleEnabled(db, id, enabled);
      deps.onConfigChanged();
      return requireRule(id);
    },

    reorder(orderedIds) {
      const current = listRules(db).map((rule) => rule.id);
      const sameSet = orderedIds.length === current.length && new Set(orderedIds).size === current.length && orderedIds.every((id) => current.includes(id));
      if (!sameSet) {
        throw new UserFacingError("規則清單已經變動，請重新整理後再調整順序");
      }
      reorderRules(db, orderedIds);
      deps.onConfigChanged();
      return listRules(db);
    },

    preview: (raw) => deps.engine.previewMatches(validated(raw)),

    async dryRun(raw, eventId) {
      const input = validated(raw);
      const event = getEvent(db, eventId);
      const project = event ? getProject(db, event.projectId) : null;
      if (!event || !project) {
        throw new UserFacingError("找不到這個事件");
      }
      return deps.engine.dryRun(input, event, project);
    },

    executions: (ruleId) => listExecutions(db, ruleId === undefined ? {} : { ruleId }),

    exportText() {
      return JSON.stringify(
        {
          format: RULES_FILE_FORMAT,
          version: RULES_FILE_VERSION,
          exportedAt: Date.now(),
          // 只有規則本身；敏感環境變數只匯出「名稱」，值永遠留在這台機器的保險庫。
          rules: listRules(db).map(toRuleInput)
        },
        null,
        2
      );
    },

    importText(text) {
      if (text.length > MAX_RULES_FILE_BYTES) {
        throw new UserFacingError("檔案太大，不像是規則匯出檔");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new UserFacingError("檔案不是有效的 JSON");
      }
      if (typeof parsed !== "object" || parsed === null || (parsed as { format?: unknown }).format !== RULES_FILE_FORMAT) {
        throw new UserFacingError("這不是 GitNRun 的規則匯出檔");
      }
      const file = parsed as { version?: unknown; rules?: unknown };
      if (file.version !== RULES_FILE_VERSION) {
        throw new UserFacingError("規則檔的版本不支援");
      }
      if (!Array.isArray(file.rules) || file.rules.length === 0 || file.rules.length > MAX_IMPORTED_RULES) {
        throw new UserFacingError(`規則檔需要 1～${MAX_IMPORTED_RULES} 條規則`);
      }

      // 全部驗證過才寫入；只要有一條不合格，整份匯入都不做。
      const errors: string[] = [];
      const inputs: RuleInput[] = [];
      file.rules.forEach((raw, index) => {
        const result = validateRuleInput(raw, `規則 ${index + 1}`);
        if (result.ok) {
          inputs.push(result.value);
        } else {
          errors.push(...result.errors);
        }
      });
      if (errors.length > 0) {
        throw new UserFacingError(errors.slice(0, 10).join("\n"));
      }

      const taken = new Set(listRules(db).map((rule) => rule.name));
      let renamed = 0;
      for (const input of inputs) {
        const name = uniqueName(input.name, taken);
        if (name !== input.name) {
          renamed += 1;
        }
        taken.add(name);
        // 來路不明的檔案不能自己關掉確認閘門，也不該一匯入就開始執行：一律「免確認＝關」、「啟用＝關」。
        createRule(db, { ...input, name, skipConfirm: false, enabled: false });
      }
      deps.onConfigChanged();
      return { imported: inputs.length, renamed };
    }
  };
};
