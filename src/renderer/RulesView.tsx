import { useCallback, useEffect, useState } from "react";
import { errorMessage, formatDateTime } from "@shared/format";
import type { Project } from "@shared/projects";
import { emptyRule, moveItem } from "@shared/rule-defaults";
import type { RuleExecution, RuleRunStatus } from "@shared/rule-runs";
import { ACTION_LABELS, CONDITION_LABELS, isWriteAction, type Rule, type RuleInput } from "@shared/rules";
import { RuleEditor } from "./RuleEditor";

const STATUS_LABEL: Record<RuleRunStatus, string> = {
  running: "執行中",
  success: "成功",
  failed: "失敗",
  timeout: "逾時",
  declined: "已拒絕",
  interrupted: "中斷"
};

const toInput = (rule: Rule): RuleInput => {
  const { id: _id, createdAt: _created, updatedAt: _updated, ...input } = rule;
  return input;
};

const summarize = (rule: Rule): string => {
  const conditions = rule.conditions.length === 0 ? "任何事件" : rule.conditions.map((condition) => CONDITION_LABELS[condition.type]).join(rule.matchMode === "all" ? " 且 " : " 或 ");
  const actions = rule.actions.map((action) => ACTION_LABELS[action.type]).join(" → ");
  return `${conditions}  ⇒  ${actions}`;
};

const ExecutionList = ({ ruleId }: { ruleId: number }) => {
  const [executions, setExecutions] = useState<RuleExecution[] | null>(null);

  useEffect(() => {
    void window.gitNRun.listRuleExecutions(ruleId).then(setExecutions);
  }, [ruleId]);

  if (executions === null) return null;
  if (executions.length === 0) return <p className="muted">還沒有執行紀錄。</p>;

  return (
    <ul className="plain-list">
      {executions.slice(0, 10).map((execution) => (
        <li key={execution.id}>
          <span className="muted">{formatDateTime(execution.startedAt)}</span> <span className="badge">{STATUS_LABEL[execution.status]}</span>{" "}
          {execution.actions.map((action) => `${ACTION_LABELS[action.type]}：${action.message}`).join("；")}
        </li>
      ))}
    </ul>
  );
};

export const RulesView = () => {
  const [rules, setRules] = useState<Rule[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [editing, setEditing] = useState<{ ruleId: number | null; initial: RuleInput } | null>(null);
  const [historyFor, setHistoryFor] = useState<number | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    void window.gitNRun.listRules().then(setRules);
  }, []);

  useEffect(() => {
    refresh();
    void window.gitNRun.listProjects().then(setProjects);
  }, [refresh]);

  const run = async (action: () => Promise<unknown>, success?: string) => {
    setError("");
    setMessage("");
    try {
      await action();
      if (success) setMessage(success);
      refresh();
    } catch (actionError) {
      setError(errorMessage(actionError));
    }
  };

  const move = (index: number, direction: -1 | 1) =>
    run(() => window.gitNRun.reorderRules(moveItem(rules, index, direction).map((rule) => rule.id)));

  return (
    <section>
      <div className="filters">
        <button type="button" onClick={() => setEditing({ ruleId: null, initial: emptyRule() })}>
          新增規則
        </button>
        <button
          type="button"
          onClick={() =>
            void run(async () => {
              const result = await window.gitNRun.exportRules();
              if (result.saved) setMessage(`已匯出到 ${result.path ?? "檔案"}（不含任何密鑰值）`);
            })
          }
        >
          匯出
        </button>
        <button
          type="button"
          onClick={() =>
            void run(async () => {
              const result = await window.gitNRun.importRules();
              if (!result.cancelled) {
                setMessage(`已匯入 ${result.imported ?? 0} 條規則。為了安全，匯入的規則都是停用狀態，請檢查後再啟用。`);
              }
            })
          }
        >
          匯入
        </button>
      </div>

      {message ? <p className="ok">{message}</p> : null}
      {error ? <p className="warn pre-line">{error}</p> : null}

      {editing ? (
        <RuleEditor
          // 切換編輯對象時重新建立編輯器，草稿不會殘留。
          key={editing.ruleId ?? "new"}
          initial={editing.initial}
          ruleId={editing.ruleId}
          projects={projects}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
          onCancel={() => setEditing(null)}
        />
      ) : null}

      {rules.length === 0 && !editing ? <p className="muted empty">還沒有規則。規則會在監視到推送時，依條件執行通知或指令。</p> : null}

      <ul className="project-list">
        {rules.map((rule, index) => (
          <li key={rule.id} className="project-row">
            <div className="project-head">
              <label className="inline-check">
                <input type="checkbox" checked={rule.enabled} onChange={(event) => void run(() => window.gitNRun.setRuleEnabled(rule.id, event.target.checked))} />
                <strong>{rule.name}</strong>
              </label>
              {rule.actions.some((action) => isWriteAction(action.type)) ? (
                <span className={`badge ${rule.skipConfirm ? "warn-badge" : ""}`}>{rule.skipConfirm ? "寫入動作免確認" : "寫入動作需確認"}</span>
              ) : null}
            </div>
            <div className="muted">{summarize(rule)}</div>
            <div className="row-actions">
              <button type="button" disabled={index === 0} onClick={() => void move(index, -1)}>
                上移
              </button>
              <button type="button" disabled={index === rules.length - 1} onClick={() => void move(index, 1)}>
                下移
              </button>
              <button type="button" onClick={() => setEditing({ ruleId: rule.id, initial: toInput(rule) })}>
                編輯
              </button>
              <button type="button" onClick={() => setHistoryFor(historyFor === rule.id ? null : rule.id)}>
                執行紀錄
              </button>
              {confirmingDelete === rule.id ? (
                <>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      setConfirmingDelete(null);
                      void run(() => window.gitNRun.deleteRule(rule.id));
                    }}
                  >
                    確定刪除
                  </button>
                  <button type="button" onClick={() => setConfirmingDelete(null)}>
                    取消
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => setConfirmingDelete(rule.id)}>
                  刪除
                </button>
              )}
            </div>
            {historyFor === rule.id ? <ExecutionList ruleId={rule.id} /> : null}
          </li>
        ))}
      </ul>
    </section>
  );
};
