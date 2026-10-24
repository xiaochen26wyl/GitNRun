import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { errorMessage } from "@shared/format";
import { feedAfterFailure, feedForMode, type FeedState, type IssueFeed } from "@shared/git-lite";
import type { RunOverview } from "@shared/run";
import { countUngroupedRunTargets } from "@shared/run-groups";
import { readOverviewCache, writeOverviewCache } from "@shared/overview-cache";

const OVERVIEW_REFRESH_MS = 4_000;
const FEED_REFRESH_MS = 60_000;

interface RunData {
  /** 還沒收到第一份資料時是 null（有上次的快取就先用快取）；之後切頁籤都沿用現有資料，背景再更新。 */
  overview: RunOverview | null;
  /** 最近一次刷新失敗的訊息；下一次成功就清空。 */
  overviewError: string;
  refreshOverview: () => void;
  /** 對不到任何分組的專案數；大於 0 才多出「其他」頁籤。 */
  ungrouped: number;
  /** issue 區塊用：含 issues 的資料，還沒拿到時維持載入中。 */
  feed: IssueFeed;
  /** 變更檔案數用：任何一份資料都行。 */
  gitFeed: IssueFeed;
  refreshFeed: () => void;
  /** 目前分組要不要連 issues 一起讀；沒有分組回報前不發請求。 */
  setWantsIssues: (wants: boolean) => void;
}

const RunDataContext = createContext<RunData | null>(null);

/**
 * 專案啟動頁的共用資料：專案概況（每 4 秒）與 git／issue（每 60 秒），都只在視窗可見時背景更新。
 * 放在 App 層，切換分組頁籤時新頁面一掛載就有現成資料，不必重抓、也不會出現空白。
 */
export const RunDataProvider = ({ children }: { children: ReactNode }) => {
  const [overview, setOverview] = useState<RunOverview | null>(readOverviewCache);
  const [overviewError, setOverviewError] = useState("");

  const refreshOverview = useCallback(() => {
    void window.gitNRun
      .getRunOverview()
      .then((next) => {
        setOverview(next);
        setOverviewError("");
        writeOverviewCache(next);
      })
      .catch((error) => setOverviewError(errorMessage(error)));
  }, []);

  useEffect(() => {
    refreshOverview();
    const timer = setInterval(() => {
      if (!document.hidden) refreshOverview();
    }, OVERVIEW_REFRESH_MS);
    // 視窗從隱藏回到可見：立刻更新，不等下一輪。
    const onVisible = () => {
      if (!document.hidden) refreshOverview();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshOverview]);

  const [wantsIssues, setWantsIssues] = useState<boolean | null>(null);
  const [feedState, setFeedState] = useState<FeedState>({ feed: { status: "loading" }, withIssues: false });
  // 切換模式時舊請求可能較晚回來，只收最新一次發出的請求。
  const latest = useRef(0);

  const refreshFeed = useCallback(() => {
    if (wantsIssues === null) return;
    latest.current += 1;
    const requestId = latest.current;
    void window.gitNRun.getGitLiteOverview({ issues: wantsIssues }).then(
      (next) => {
        if (requestId === latest.current) setFeedState({ feed: { status: "ready", overview: next }, withIssues: wantsIssues });
      },
      (error) => {
        if (requestId !== latest.current) return;
        // 已有資料時，這一輪失敗不洗掉畫面。
        setFeedState((current) => feedAfterFailure(current, errorMessage(error), wantsIssues));
      }
    );
  }, [wantsIssues]);

  useEffect(() => {
    refreshFeed();
    const timer = setInterval(() => {
      if (!document.hidden) refreshFeed();
    }, FEED_REFRESH_MS);
    const onVisible = () => {
      if (!document.hidden) refreshFeed();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshFeed]);

  const ungrouped = useMemo(() => (overview === null ? 0 : countUngroupedRunTargets(overview.targets)), [overview]);

  const value = useMemo<RunData>(
    () => ({
      overview,
      overviewError,
      refreshOverview,
      ungrouped,
      feed: feedForMode(feedState, wantsIssues === true),
      gitFeed: feedState.feed,
      refreshFeed,
      setWantsIssues
    }),
    [overview, overviewError, refreshOverview, ungrouped, feedState, wantsIssues, refreshFeed]
  );

  return <RunDataContext.Provider value={value}>{children}</RunDataContext.Provider>;
};

export const useRunData = (): RunData => {
  const value = useContext(RunDataContext);
  if (value === null) throw new Error("useRunData 必須在 RunDataProvider 內使用");
  return value;
};
