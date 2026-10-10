import type { LaunchTarget } from "@shared/launcher";

/**
 * 托盤選單的內容（純資料）。Electron 那層只負責把每個項目的 action 對應到實際動作，
 * 所以選單長什麼樣子、什麼狀況顯示什麼，可以不開任何視窗就測試。
 */

export type TrayAction =
  | { type: "open-window" }
  | { type: "toggle-pause" }
  | { type: "launch"; folder: string }
  | { type: "quit" };

export type TrayItem =
  | { kind: "item"; label: string; action: TrayAction; enabled?: boolean }
  | { kind: "label"; label: string }
  | { kind: "separator" };

export interface TrayModel {
  paused: boolean;
  /** 因 rate limit 暫停到何時（epoch ms）。 */
  rateLimitedUntil: number | null;
  projectCount: number;
  recentEvents: Array<{ label: string }>;
  targets: LaunchTarget[];
}

const clock = (timestamp: number): string => {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

export const statusLabel = (model: Pick<TrayModel, "paused" | "rateLimitedUntil" | "projectCount">): string => {
  if (model.paused) return "監視已暫停";
  if (model.rateLimitedUntil !== null) return `GitHub 限流中，${clock(model.rateLimitedUntil)} 後恢復`;
  return model.projectCount === 0 ? "尚未設定專案" : `監視中（${model.projectCount} 個專案）`;
};

export const buildTrayItems = (model: TrayModel): TrayItem[] => {
  const items: TrayItem[] = [
    { kind: "label", label: statusLabel(model) },
    { kind: "item", label: model.paused ? "恢復監視" : "暫停監視", action: { type: "toggle-pause" } },
    { kind: "separator" },
    { kind: "item", label: "開啟 GitNRun", action: { type: "open-window" } }
  ];

  if (model.recentEvents.length > 0) {
    items.push({ kind: "separator" }, { kind: "label", label: "最近的推送" });
    for (const event of model.recentEvents) {
      items.push({ kind: "item", label: event.label, action: { type: "open-window" } });
    }
  }

  items.push({ kind: "separator" }, { kind: "label", label: "在終端機開啟" });
  if (model.targets.length === 0) {
    items.push({ kind: "label", label: "尚未設定專案路徑或資料夾映射" });
  } else {
    for (const target of model.targets) {
      items.push({ kind: "item", label: target.label, action: { type: "launch", folder: target.folder } });
    }
  }

  items.push({ kind: "separator" }, { kind: "item", label: "結束", action: { type: "quit" } });
  return items;
};
