import { planChangeBadge, type IssueFeed } from "@shared/git-lite";

/** 專案卡片標題下的變更檔案數；達門檻時換警示色並提示該推送了，判斷都在 planChangeBadge。 */
export const ChangeBadge = ({ feed, folder }: { feed: IssueFeed; folder: string }) => {
  const plan = planChangeBadge(feed, folder);
  if (plan.kind === "hidden") return null;

  return (
    <div className={plan.reminder === null ? "change-badge" : "change-badge reached"}>
      <span className="mono">{plan.text}</span>
      {plan.reminder === null ? null : <strong>{plan.reminder}</strong>}
    </div>
  );
};
