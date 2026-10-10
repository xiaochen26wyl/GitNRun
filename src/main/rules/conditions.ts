import type { PushEvent } from "@shared/events";
import { matchGlob } from "@shared/glob";
import type { Project } from "@shared/projects";
import type { RuleCondition, RuleInput } from "@shared/rules";

/** 規則條件的評估（純函式）。事件內容永遠只當資料比對，不會被當成指令或樣式。 */

/** 檔案樣式：沒有 "/" 的樣式（如 *.js）比對檔名，所以 src/a/b.js 也算符合。 */
export const matchesFilePattern = (pattern: string, path: string): boolean => {
  if (pattern.includes("/")) {
    return matchGlob(pattern, path, { pathAware: true });
  }
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return matchGlob(pattern, basename, { pathAware: true });
};

const toMinutes = (time: string): number => {
  const [hours, minutes] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
};

/** 起訖時間（含跨午夜）。起訖相同代表整天。星期以事件發生當下的本地時間為準。 */
export const matchesTime = (condition: Extract<RuleCondition, { type: "time" }>, at: number): boolean => {
  const date = new Date(at);
  const minutes = date.getHours() * 60 + date.getMinutes();
  const from = toMinutes(condition.from);
  const to = toMinutes(condition.to);

  const inWindow = from === to ? true : from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
  const dayOk = condition.days.includes(date.getDay());
  const inside = inWindow && dayOk;
  return condition.match === "inside" ? inside : !inside;
};

export const evaluateCondition = (condition: RuleCondition, event: PushEvent, project: Project): boolean => {
  switch (condition.type) {
    case "branch":
      return condition.patterns.some((pattern) => matchGlob(pattern, event.branch));
    case "file":
      return event.files.some((file) => condition.patterns.some((pattern) => matchesFilePattern(pattern, file.path)));
    case "pusher": {
      if (event.pusher === null) {
        return false;
      }
      const pusher = event.pusher.toLowerCase();
      return condition.names.some((name) => name.toLowerCase() === pusher);
    }
    case "time":
      return matchesTime(condition, event.occurredAt);
    case "file_count":
      return condition.op === "gte" ? event.fileCount >= condition.value : event.fileCount <= condition.value;
    case "branch_violation":
      return event.branchViolation === condition.value;
    case "event_type":
      return condition.types.includes(event.eventType);
    case "project":
      return condition.projectIds.includes(project.id);
  }
};

export interface ConditionOutcome {
  type: string;
  matched: boolean;
}

export interface RuleMatch {
  matched: boolean;
  conditions: ConditionOutcome[];
}

/** 沒有條件代表不限制，任何事件都符合。 */
export const evaluateRule = (
  rule: Pick<RuleInput, "matchMode" | "conditions">,
  event: PushEvent,
  project: Project
): RuleMatch => {
  const conditions = rule.conditions.map((condition) => ({
    type: condition.type,
    matched: evaluateCondition(condition, event, project)
  }));
  if (conditions.length === 0) {
    return { matched: true, conditions };
  }
  const matched =
    rule.matchMode === "all" ? conditions.every((outcome) => outcome.matched) : conditions.some((outcome) => outcome.matched);
  return { matched, conditions };
};
