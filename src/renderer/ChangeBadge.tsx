import { useEffect, useRef } from "react";
import { planChangeBadge, type IssueFeed } from "@shared/git-lite";

/** 專案卡片標題下的變更檔案數；達門檻時換警示色並提示該推送了，判斷都在 planChangeBadge。 */
export const ChangeBadge = ({ feed, folder, label }: { feed: IssueFeed; folder: string; label: string }) => {
  const plan = planChangeBadge(feed, folder);
  // 跨輪詢持續存在，記錄「上次是否已達門檻」，只在第一次跨過時跳系統通知，避免每次輪詢都重複跳。
  const wasReminded = useRef(false);

  useEffect(() => {
    const reminder = plan.kind === "badge" ? plan.reminder : null;
    if (reminder !== null && !wasReminded.current) {
      void window.gitNRun.showDesktopNotification("GitNRun", `${label} ${reminder}`);
    }
    wasReminded.current = reminder !== null;
  }, [plan, label]);

  if (plan.kind === "hidden") return null;

  return (
    <div className={plan.reminder === null ? "change-badge" : "change-badge reached"}>
      <span className="mono">{plan.text}</span>
      {plan.reminder === null ? null : <strong>{plan.reminder}</strong>}
    </div>
  );
};
