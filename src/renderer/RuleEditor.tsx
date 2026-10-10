import { useEffect, useState, type ReactNode } from "react";
import type { EventType, PushEvent } from "@shared/events";
import { errorMessage } from "@shared/format";
import type { Project } from "@shared/projects";
import type { DryRunReport, RulePreviewReport } from "@shared/rule-runs";
import {
  defaultAction,
  defaultCondition,
  envToLines,
  linesToList,
  listToLines,
  moveItem,
  parseEnvLines,
  parseNameList
} from "@shared/rule-defaults";
import {
  ACTION_LABELS,
  ACTION_TYPES,
  CONDITION_LABELS,
  CONDITION_TYPES,
  EVENT_TEMPLATE_VARIABLES,
  GIT_COMMANDS,
  isWriteAction,
  type ActionType,
  type ConditionType,
  type RuleAction,
  type RuleCondition,
  type RuleInput
} from "@shared/rules";
import { COMMON_TYPES } from "@shared/branch-template";
import { COMMAND_PRESETS } from "@shared/command-presets";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const EVENT_TYPE_OPTIONS: ReadonlyArray<{ id: EventType; label: string }> = [
  { id: "push", label: "推送" },
  { id: "create", label: "新分支" },
  { id: "delete", label: "刪除分支" }
];

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="field">
    {label}
    {children}
  </label>
);

// ---------------------------------------------------------------------------
// 條件
// ---------------------------------------------------------------------------

const ConditionFields = ({
  condition,
  projects,
  onChange
}: {
  condition: RuleCondition;
  projects: Project[];
  onChange: (next: RuleCondition) => void;
}) => {
  switch (condition.type) {
    case "branch":
    case "file":
      return (
        <Field label={condition.type === "branch" ? "分支（每行一個，支援 * ?）" : "檔案（每行一個，如 *.js、src/**）"}>
          <textarea rows={3} value={listToLines(condition.patterns)} onChange={(event) => onChange({ ...condition, patterns: linesToList(event.target.value) })} />
        </Field>
      );
    case "pusher":
      return (
        <Field label="推送者（每行一個，不分大小寫）">
          <textarea rows={3} value={listToLines(condition.names)} onChange={(event) => onChange({ ...condition, names: linesToList(event.target.value) })} />
        </Field>
      );
    case "time":
      return (
        <div className="filters">
          <select value={condition.match} onChange={(event) => onChange({ ...condition, match: event.target.value === "outside" ? "outside" : "inside" })}>
            <option value="inside">在這段時間內</option>
            <option value="outside">不在這段時間內</option>
          </select>
          <input type="time" value={condition.from} onChange={(event) => onChange({ ...condition, from: event.target.value })} />
          <span>到</span>
          <input type="time" value={condition.to} onChange={(event) => onChange({ ...condition, to: event.target.value })} />
          {WEEKDAYS.map((label, day) => (
            <label key={label} className="inline-check">
              <input
                type="checkbox"
                checked={condition.days.includes(day)}
                onChange={(event) =>
                  onChange({ ...condition, days: event.target.checked ? [...condition.days, day].sort() : condition.days.filter((item) => item !== day) })
                }
              />
              {label}
            </label>
          ))}
        </div>
      );
    case "file_count":
      return (
        <div className="filters">
          <span>變更檔案數</span>
          <select value={condition.op} onChange={(event) => onChange({ ...condition, op: event.target.value === "lte" ? "lte" : "gte" })}>
            <option value="gte">至少</option>
            <option value="lte">至多</option>
          </select>
          <input type="number" min={0} value={condition.value} onChange={(event) => onChange({ ...condition, value: Number(event.target.value) })} />
        </div>
      );
    case "branch_violation":
      return (
        <select value={String(condition.value)} onChange={(event) => onChange({ ...condition, value: event.target.value === "true" })}>
          <option value="true">分支名稱不符命名規則</option>
          <option value="false">分支名稱符合命名規則</option>
        </select>
      );
    case "event_type":
      return (
        <div className="filters">
          {EVENT_TYPE_OPTIONS.map((option) => (
            <label key={option.id} className="inline-check">
              <input
                type="checkbox"
                checked={condition.types.includes(option.id)}
                onChange={(event) =>
                  onChange({ ...condition, types: event.target.checked ? [...condition.types, option.id] : condition.types.filter((item) => item !== option.id) })
                }
              />
              {option.label}
            </label>
          ))}
        </div>
      );
    case "project":
      return (
        <div className="filters">
          {projects.length === 0 ? <span className="muted">還沒有專案</span> : null}
          {projects.map((project) => (
            <label key={project.id} className="inline-check">
              <input
                type="checkbox"
                checked={condition.projectIds.includes(project.id)}
                onChange={(event) =>
                  onChange({ ...condition, projectIds: event.target.checked ? [...condition.projectIds, project.id] : condition.projectIds.filter((id) => id !== project.id) })
                }
              />
              {project.name}
            </label>
          ))}
        </div>
      );
  }
};

// ---------------------------------------------------------------------------
// 動作
// ---------------------------------------------------------------------------

const SecretEnvInputs = ({ ruleId, names }: { ruleId: number | null; names: string[] }) => {
  const [configured, setConfigured] = useState<Set<string>>(new Set());
  const [values, setValues] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");

  const refresh = () => {
    void window.gitNRun.getSecretsOverview().then((overview) => {
      setConfigured(new Set(overview.secrets.filter((secret) => secret.configured).map((secret) => secret.name)));
    });
  };

  useEffect(refresh, [ruleId]);

  if (names.length === 0) {
    return null;
  }
  if (ruleId === null) {
    return <p className="muted">先儲存規則，才能設定敏感環境變數的值（值只存在這台電腦的 Keychain 加密保險庫）。</p>;
  }

  return (
    <div className="subpanel">
      {names.map((name) => {
        const secretName = `env.${ruleId}.${name}`;
        return (
          <div key={name} className="secret-controls">
            <span className="mono">{name}</span>
            <input
              type="password"
              autoComplete="off"
              placeholder={configured.has(secretName) ? "已設定，輸入新值以取代" : "尚未設定"}
              value={values[name] ?? ""}
              onChange={(event) => setValues({ ...values, [name]: event.target.value })}
            />
            <button
              type="button"
              disabled={(values[name] ?? "").trim() === ""}
              onClick={() => {
                setMessage("");
                window.gitNRun
                  .setSecret(secretName, values[name] ?? "")
                  .then(() => {
                    setValues({ ...values, [name]: "" });
                    refresh();
                  })
                  .catch((error) => setMessage(errorMessage(error)));
              }}
            >
              儲存
            </button>
          </div>
        );
      })}
      {message ? <p className="warn">{message}</p> : null}
    </div>
  );
};

const RetryFields = ({
  action,
  onChange
}: {
  action: Extract<RuleAction, { type: "git" | "shell" }>;
  onChange: (next: RuleAction) => void;
}) => (
  <>
    <div className="filters">
      <label className="inline-check">
        逾時（秒）
        <input type="number" min={1} max={3600} value={action.timeoutSec} onChange={(event) => onChange({ ...action, timeoutSec: Number(event.target.value) })} />
      </label>
      <label className="inline-check">
        失敗後重試
        <input type="number" min={0} max={5} value={action.retries} onChange={(event) => onChange({ ...action, retries: Number(event.target.value) })} />
        次
      </label>
      <label className="inline-check">
        第一次等待（秒，之後加倍）
        <input type="number" min={1} max={300} value={action.retryDelaySec} onChange={(event) => onChange({ ...action, retryDelaySec: Number(event.target.value) })} />
      </label>
    </div>
    {action.retries > 0 ? <p className="warn">重試會把指令再跑一次；會改動資料、不能重複執行的指令（例如 push 之後的部署）不建議重試。</p> : null}
  </>
);

const ActionFields = ({
  action,
  ruleId,
  onChange
}: {
  action: RuleAction;
  ruleId: number | null;
  onChange: (next: RuleAction) => void;
}) => {
  switch (action.type) {
    case "ai_commit_message":
      return (
        <p className="muted">
          根據專案本機尚未提交的變更產生 commit 訊息，結果可以在後面的動作用 {"{ai_commit_message}"}（通知文字、git commit 參數）或 PW_AI_COMMIT_MESSAGE（shell）取得。
          專案需要在「專案」分頁允許 AI 分析，否則會改用本機規則。
        </p>
      );
    case "ai_summary":
      return (
        <p className="muted">
          摘要這次推送（只用 commit 訊息與檔名，不送程式碼），結果可以在後面的動作用 {"{ai_summary}"} 或 PW_AI_SUMMARY（shell）取得。同一專案短時間內的多次推送會合併成一次請求。
        </p>
      );
    case "notify_system":
      return (
        <>
          <p className="muted">可用變數：{[...EVENT_TEMPLATE_VARIABLES, "ai_summary", "ai_commit_message"].map((name) => `{${name}}`).join(" ")}（留空則用預設文字）</p>
          <Field label="標題">
            <input value={action.title ?? ""} onChange={(event) => onChange({ ...action, title: event.target.value || undefined })} />
          </Field>
          <Field label="內容">
            <input value={action.body ?? ""} onChange={(event) => onChange({ ...action, body: event.target.value || undefined })} />
          </Field>
        </>
      );
    case "notify_slack":
      return (
        <Field label="訊息（可用 {變數}；留空則用預設文字。Webhook URL 在「設定」中保存）">
          <input value={action.text ?? ""} onChange={(event) => onChange({ ...action, text: event.target.value || undefined })} />
        </Field>
      );
    case "notify_webhook":
      return (
        <>
          <Field label="網址（http／https）">
            <input value={action.url} onChange={(event) => onChange({ ...action, url: event.target.value })} placeholder="https://example.com/hook" />
          </Field>
          <label className="inline-check">
            <input type="checkbox" checked={action.includeEvent} onChange={(event) => onChange({ ...action, includeEvent: event.target.checked })} />
            附上事件摘要（commit、檔案、推送者）
          </label>
        </>
      );
    case "notify_email":
      return (
        <>
          <p className="warn">郵件通知尚未支援；此動作目前執行時會回報失敗。</p>
          <Field label="收件者">
            <input value={action.to} onChange={(event) => onChange({ ...action, to: event.target.value })} />
          </Field>
        </>
      );
    case "git":
      return (
        <>
        <p className="muted">參數可用 {"{branch}"}、{"{sha}"}、{"{before_sha}"}（先驗證再代入）；會執行外部程式的選項（如 --upload-pack）一律拒絕。</p>
        <div className="filters">
          <select value={action.command} onChange={(event) => onChange({ ...action, command: GIT_COMMANDS.find((name) => name === event.target.value) ?? "fetch" })}>
            {GIT_COMMANDS.map((name) => (
              <option key={name} value={name}>
                git {name}
              </option>
            ))}
          </select>
          <textarea
            rows={2}
            aria-label="參數"
            placeholder="參數，每行一個"
            value={listToLines(action.args)}
            onChange={(event) => onChange({ ...action, args: linesToList(event.target.value) })}
          />
        </div>
        <RetryFields action={action} onChange={onChange} />
        </>
      );
    case "shell":
      return (
        <>
          <p className="muted">事件內容（分支、訊息等）只會以環境變數 PW_BRANCH、PW_PUSHER、PW_MESSAGE、PW_SHA 等傳入，不會拼進指令。</p>
          <select
            aria-label="常用指令模板"
            value=""
            onChange={(event) => {
              const preset = COMMAND_PRESETS.find((candidate) => candidate.id === event.target.value);
              if (preset) onChange({ ...action, command: preset.command });
            }}
          >
            <option value="">套用常用指令模板…</option>
            {COMMAND_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
          <Field label="指令（以 zsh 執行，在專案的本機資料夾裡）">
            <textarea className="mono" rows={3} value={action.command} onChange={(event) => onChange({ ...action, command: event.target.value })} spellCheck={false} />
          </Field>
          <RetryFields action={action} onChange={onChange} />
          <Field label="環境變數（NAME=value，每行一組）">
            <textarea className="mono" rows={2} value={envToLines(action.env)} onChange={(event) => onChange({ ...action, env: parseEnvLines(event.target.value) })} spellCheck={false} />
          </Field>
          <Field label="敏感環境變數名稱（逗號分隔；值存放在加密保險庫，不會出現在規則或備份裡）">
            <input className="mono" value={action.secretEnvNames.join(", ")} onChange={(event) => onChange({ ...action, secretEnvNames: parseNameList(event.target.value) })} />
          </Field>
          <SecretEnvInputs ruleId={ruleId} names={action.secretEnvNames} />
        </>
      );
    case "create_work_branch":
      return (
        <div className="filters">
          <select value={action.branchType ?? ""} onChange={(event) => onChange({ ...action, branchType: event.target.value || undefined })}>
            <option value="">類型（範本需要時才使用）</option>
            {COMMON_TYPES.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <input
            placeholder="描述（可用 {branch}、{pusher} 等變數）"
            value={action.slug ?? ""}
            onChange={(event) => onChange({ ...action, slug: event.target.value || undefined })}
          />
        </div>
      );
  }
};

// ---------------------------------------------------------------------------
// 編輯器本體
// ---------------------------------------------------------------------------

interface Props {
  initial: RuleInput;
  ruleId: number | null;
  projects: Project[];
  onSaved: () => void;
  onCancel: () => void;
}

export const RuleEditor = ({ initial, ruleId, projects, onSaved, onCancel }: Props) => {
  const [draft, setDraft] = useState<RuleInput>(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<RulePreviewReport | null>(null);
  const [recentEvents, setRecentEvents] = useState<PushEvent[]>([]);
  const [testEventId, setTestEventId] = useState<number | "">("");
  const [dryRun, setDryRun] = useState<DryRunReport | null>(null);

  useEffect(() => {
    void window.gitNRun.queryEvents({ limit: 30 }).then((page) => setRecentEvents(page.events));
  }, []);

  const guard = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (actionError) {
      setError(errorMessage(actionError));
    } finally {
      setBusy(false);
    }
  };

  const update = (patch: Partial<RuleInput>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setPreview(null);
    setDryRun(null);
  };

  const replaceAt = <T,>(list: readonly T[], index: number, next: T): T[] => list.map((item, position) => (position === index ? next : item));

  const hasWriteAction = draft.actions.some((action) => isWriteAction(action.type));

  return (
    <div className="subpanel editor">
      <h3>{ruleId === null ? "新增規則" : "編輯規則"}</h3>

      <div className="form-grid">
        <Field label="名稱">
          <input value={draft.name} onChange={(event) => update({ name: event.target.value })} />
        </Field>
        <Field label="優先順序（數字小的先執行）">
          <input type="number" value={draft.priority} onChange={(event) => update({ priority: Number(event.target.value) })} />
        </Field>
        <Field label="冷卻時間（秒；同一分支兩次執行至少間隔，0 = 不限）">
          <input type="number" min={0} value={draft.cooldownSec} onChange={(event) => update({ cooldownSec: Number(event.target.value) })} />
        </Field>
        <Field label="條件組合">
          <select value={draft.matchMode} onChange={(event) => update({ matchMode: event.target.value === "any" ? "any" : "all" })}>
            <option value="all">全部條件都成立</option>
            <option value="any">任一條件成立</option>
          </select>
        </Field>
      </div>
      <label className="inline-check">
        <input type="checkbox" checked={draft.enabled} onChange={(event) => update({ enabled: event.target.checked })} />
        啟用
      </label>

      <h4>觸發條件</h4>
      {draft.conditions.length === 0 ? <p className="warn">沒有條件：每一個推送事件都會觸發這條規則。</p> : null}
      {draft.conditions.map((condition, index) => (
        <div key={index} className="subpanel">
          <div className="filters">
            <select
              value={condition.type}
              onChange={(event) => update({ conditions: replaceAt(draft.conditions, index, defaultCondition(event.target.value as ConditionType)) })}
            >
              {CONDITION_TYPES.map((type) => (
                <option key={type} value={type}>
                  {CONDITION_LABELS[type]}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => update({ conditions: draft.conditions.filter((_, position) => position !== index) })}>
              移除
            </button>
          </div>
          <ConditionFields condition={condition} projects={projects} onChange={(next) => update({ conditions: replaceAt(draft.conditions, index, next) })} />
        </div>
      ))}
      <button type="button" onClick={() => update({ conditions: [...draft.conditions, defaultCondition("branch")] })}>
        新增條件
      </button>

      <h4>動作（依序執行）</h4>
      {draft.actions.map((action, index) => (
        <div key={index} className="subpanel">
          <div className="filters">
            <select value={action.type} onChange={(event) => update({ actions: replaceAt(draft.actions, index, defaultAction(event.target.value as ActionType)) })}>
              {ACTION_TYPES.map((type) => (
                <option key={type} value={type}>
                  {ACTION_LABELS[type]}
                  {isWriteAction(type) ? "（需確認）" : ""}
                </option>
              ))}
            </select>
            <button type="button" disabled={index === 0} onClick={() => update({ actions: moveItem(draft.actions, index, -1) })}>
              上移
            </button>
            <button type="button" disabled={index === draft.actions.length - 1} onClick={() => update({ actions: moveItem(draft.actions, index, 1) })}>
              下移
            </button>
            <button type="button" onClick={() => update({ actions: draft.actions.filter((_, position) => position !== index) })}>
              移除
            </button>
          </div>
          <ActionFields action={action} ruleId={ruleId} onChange={(next) => update({ actions: replaceAt(draft.actions, index, next) })} />
          <label className="inline-check">
            <input
              type="checkbox"
              checked={action.continueOnFailure === true}
              onChange={(event) => update({ actions: replaceAt(draft.actions, index, { ...action, continueOnFailure: event.target.checked || undefined }) })}
            />
            這個動作失敗、被拒絕或逾時後，仍繼續執行後面的動作
          </label>
        </div>
      ))}
      <button type="button" onClick={() => update({ actions: [...draft.actions, defaultAction("notify_system")] })}>
        新增動作
      </button>

      {hasWriteAction ? (
        <div className="subpanel">
          <label className="inline-check">
            <input type="checkbox" checked={draft.skipConfirm} onChange={(event) => update({ skipConfirm: event.target.checked })} />
            寫入型動作免確認，符合條件就直接執行
          </label>
          {draft.skipConfirm ? (
            <p className="warn">風險提示：遠端的推送一符合條件，就會在這台電腦上直接執行上面的指令，不會再問你。</p>
          ) : (
            <p className="muted">預設：執行寫入型動作之前會先跳出視窗，顯示完整內容並等你允許。</p>
          )}
        </div>
      ) : null}

      <h4>檢查這條規則</h4>
      <div className="filters">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void guard(async () => {
              setPreview(await window.gitNRun.previewRule(draft));
            })
          }
        >
          用歷史事件預覽會命中哪些
        </button>
        {preview ? (
          <span>
            檢查最近 {preview.examined} 筆事件，會命中 <strong>{preview.matchedEventIds.length}</strong> 筆
          </span>
        ) : null}
      </div>
      <div className="filters">
        <select value={testEventId} onChange={(event) => setTestEventId(event.target.value === "" ? "" : Number(event.target.value))}>
          <option value="">選一個事件來乾跑測試…</option>
          {recentEvents.map((event) => (
            <option key={event.id} value={event.id}>
              {event.branch} · {event.headMessage || event.eventType}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy || testEventId === ""}
          onClick={() =>
            void guard(async () => {
              if (testEventId !== "") setDryRun(await window.gitNRun.dryRunRule(draft, testEventId));
            })
          }
        >
          乾跑（不會執行任何動作）
        </button>
      </div>
      {dryRun ? (
        <div className="subpanel">
          <p className={dryRun.matched ? "ok" : "warn"}>{dryRun.matched ? "條件符合，這條規則會執行" : "條件不符合，這個事件不會觸發"}</p>
          <ul className="plain-list">
            {dryRun.conditions.map((condition, index) => (
              <li key={index}>
                {condition.matched ? "✓" : "✗"} {CONDITION_LABELS[condition.type as ConditionType] ?? condition.type}
              </li>
            ))}
          </ul>
          <ol className="steps">
            {dryRun.actions.map((action) => (
              <li key={action.index}>
                <strong>{ACTION_LABELS[action.type]}</strong>（{action.requiresConfirmation ? "會先請你確認" : action.write ? "免確認" : "自動執行"}）
                <pre className="output">{action.summary}</pre>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {error ? <p className="warn pre-line">{error}</p> : null}
      <div className="row-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void guard(async () => {
              if (ruleId === null) await window.gitNRun.createRule(draft);
              else await window.gitNRun.updateRule(ruleId, draft);
              onSaved();
            })
          }
        >
          儲存
        </button>
        <button type="button" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
};
