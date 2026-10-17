import { useCallback, useState } from "react";
import type { RunGroupId } from "@shared/run-groups";
import {
  moveItem,
  parseRunOrder,
  parseRunSortModes,
  serializeRunOrder,
  serializeRunSortModes,
  withRunSortMode,
  type RunOrder,
  type RunOrderEntry,
  type RunSortMode,
  type RunSortModes
} from "@shared/run-order";

const ORDER_PREF_KEY = "gitnrun.run.order";
const SORT_MODE_PREF_KEY = "gitnrun.run.sortMode";

/** 專案與 App 的手動排序：只是這台機器上的檢視設定，存在 localStorage；讀寫失敗就用預設順序。 */
export const useRunOrderPref = (): [RunOrder, (next: RunOrder) => void] => {
  const [order, setOrder] = useState<RunOrder>(() => {
    try {
      return parseRunOrder(localStorage.getItem(ORDER_PREF_KEY));
    } catch {
      return parseRunOrder(null);
    }
  });

  const update = useCallback((next: RunOrder) => {
    setOrder(next);
    try {
      localStorage.setItem(ORDER_PREF_KEY, serializeRunOrder(next));
    } catch {
      // 寫不進去就只在這次執行期間生效。
    }
  }, []);

  return [order, update];
};

/** 每個頁籤各自記住「手動」或「issue 數量」排序；沒選過的頁籤是手動。讀寫失敗就只在這次執行期間生效。 */
export const useRunSortModePref = (): [RunSortModes, (groupId: RunGroupId, mode: RunSortMode) => void] => {
  const [modes, setModes] = useState<RunSortModes>(() => {
    try {
      return parseRunSortModes(localStorage.getItem(SORT_MODE_PREF_KEY));
    } catch {
      return parseRunSortModes(null);
    }
  });

  const update = useCallback(
    (groupId: RunGroupId, mode: RunSortMode) => {
      const next = withRunSortMode(modes, groupId, mode);
      setModes(next);
      try {
        localStorage.setItem(SORT_MODE_PREF_KEY, serializeRunSortModes(next));
      } catch {
        // 寫不進去就只在這次執行期間生效。
      }
    },
    [modes]
  );

  return [modes, update];
};

/** 專案排序方式的二選一切換：目前的模式用實心按鈕，另一個是 ghost。note 是資料還沒到位時的說明。 */
export const RunSortSwitch = ({ mode, onChange, note }: { mode: RunSortMode; onChange: (mode: RunSortMode) => void; note: string | null }) => (
  <div className="run-sort-switch" role="group" aria-label="專案排序方式">
    <span className="muted">排序</span>
    <button type="button" className={mode === "manual" ? "" : "ghost"} aria-pressed={mode === "manual"} onClick={() => onChange("manual")}>
      手動
    </button>
    <button type="button" className={mode === "issues" ? "" : "ghost"} aria-pressed={mode === "issues"} onClick={() => onChange("issues")}>
      issue 數量
    </button>
    {note === null ? null : <span className="muted">{note}</span>}
  </div>
);

const MoveButtons = ({
  label,
  index,
  count,
  locked = false,
  onMove
}: {
  label: string;
  index: number;
  count: number;
  /** 鎖定時兩顆都停用，並說明原因。 */
  locked?: boolean;
  onMove: (delta: -1 | 1) => void;
}) => (
  <span className="run-order-moves" title={locked ? "專案目前依 issue 數量自動排序，切回「手動」才能調整專案順序" : undefined}>
    <button type="button" className="ghost" disabled={locked || index === 0} aria-label={`${label} 上移`} title={locked ? undefined : "上移"} onClick={() => onMove(-1)}>
      ▲
    </button>
    <button type="button" className="ghost" disabled={locked || index === count - 1} aria-label={`${label} 下移`} title={locked ? undefined : "下移"} onClick={() => onMove(1)}>
      ▼
    </button>
  </span>
);

const keysOf = (entries: readonly RunOrderEntry[]): string => JSON.stringify(entries.map((entry) => [entry.key, entry.apps.map((app) => app.key)]));

/** 還原預設：專案順序鎖定時只還原 App 順序，專案維持目前畫面上的順序。 */
const restoreDefaults = (draft: readonly RunOrderEntry[], defaults: readonly RunOrderEntry[], projectsLocked: boolean): readonly RunOrderEntry[] =>
  projectsLocked ? draft.map((entry) => ({ ...entry, apps: defaults.find((candidate) => candidate.key === entry.key)?.apps ?? entry.apps })) : defaults;

/**
 * 排序編輯面板：每個專案一行，用 ▲▼ 移動；專案底下的 App 展開後也能各自移動。
 * 調整只改面板內的草稿，按「固定順序」才交給外層儲存，「取消」就整份放棄。
 * initial 只在面板出現時讀一次（之後定期刷新不會洗掉草稿）；defaults 是沒有任何手動排序時的順序，給「還原預設」用。
 */
export const RunOrderEditor = ({
  initial,
  defaults,
  projectsLocked = false,
  onSave,
  onCancel
}: {
  initial: readonly RunOrderEntry[];
  defaults: readonly RunOrderEntry[];
  /** 專案正由 issue 數量自動排序：專案的 ▲▼ 停用，只能調整 App 順序。 */
  projectsLocked?: boolean;
  onSave: (entries: readonly RunOrderEntry[]) => void;
  onCancel: () => void;
}) => {
  const [draft, setDraft] = useState<readonly RunOrderEntry[]>(initial);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const moveEntry = (index: number, delta: -1 | 1): void => setDraft((entries) => moveItem(entries, index, delta));
  const moveApp = (index: number, appIndex: number, delta: -1 | 1): void =>
    setDraft((entries) => entries.map((entry, entryIndex) => (entryIndex === index ? { ...entry, apps: moveItem(entry.apps, appIndex, delta) } : entry)));
  const toggle = (key: string): void =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <section className="run-order" aria-label="調整順序">
      <div className="run-order-head">
        <div>
          <h2>調整順序</h2>
          <p className="muted">用 ▲▼ 移動專案；有多個 App 的專案可以展開，再調整裡面的順序。按「固定順序」才會儲存，切換頁籤會放棄尚未固定的調整。</p>
          {projectsLocked ? <p className="muted">專案目前依 issue 數量自動排序，順序已鎖定；切回「手動」才能調整專案順序，App 順序仍可調整。</p> : null}
        </div>
        <div className="row-actions">
          <button
            type="button"
            className="ghost"
            disabled={keysOf(draft) === keysOf(restoreDefaults(draft, defaults, projectsLocked))}
            onClick={() => setDraft(restoreDefaults(draft, defaults, projectsLocked))}
          >
            還原預設
          </button>
          <button type="button" className="ghost" onClick={onCancel}>
            取消
          </button>
          <button type="button" onClick={() => onSave(draft)}>
            固定順序
          </button>
        </div>
      </div>

      <ol className="run-order-list">
        {draft.map((entry, index) => (
          <li className="run-order-item" key={entry.key}>
            <div className="run-order-line">
              <MoveButtons label={entry.label} index={index} count={draft.length} locked={projectsLocked} onMove={(delta) => moveEntry(index, delta)} />
              <strong>{entry.label}</strong>
              {entry.apps.length > 1 ? (
                <button type="button" className="ghost" aria-expanded={expanded.has(entry.key)} onClick={() => toggle(entry.key)}>
                  {expanded.has(entry.key) ? "收合 App" : `展開 App（${entry.apps.length}）`}
                </button>
              ) : null}
            </div>
            {expanded.has(entry.key) ? (
              <ol className="run-order-apps">
                {entry.apps.map((app, appIndex) => (
                  <li className="run-order-line" key={app.key}>
                    <MoveButtons label={`${entry.label} ${app.label}`} index={appIndex} count={entry.apps.length} onMove={(delta) => moveApp(index, appIndex, delta)} />
                    <span>{app.label}</span>
                  </li>
                ))}
              </ol>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
};
