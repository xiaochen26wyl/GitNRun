import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PushEvent } from "@shared/events";
import type { Project } from "@shared/projects";
import type { RuleCondition } from "@shared/rules";
import { evaluateCondition, evaluateRule, matchesFilePattern, matchesTime } from "@main/rules/conditions";

type TimeCondition = Extract<RuleCondition, { type: "time" }>;

const project = { id: 7, name: "acme/api" } as Project;

const event = (overrides: Partial<PushEvent> = {}): PushEvent => ({
  id: 1, projectId: 7, eventType: "push", ref: "refs/heads/main", branch: "main",
  beforeSha: null, afterSha: "a".repeat(40), pusher: "Alice", pusherInferred: true,
  headMessage: "", commits: [], files: [], fileCount: 0, branchViolation: false,
  source: "poll", occurredAt: new Date(2026, 9, 9, 10, 30).getTime(), createdAt: 0,
  ...overrides
});

describe("branch and pusher conditions", () => {
  it("branch matches any pattern, slashes included", () => {
    const condition: RuleCondition = { type: "branch", patterns: ["main", "release/*"] };
    assert.equal(evaluateCondition(condition, event({ branch: "main" }), project), true);
    assert.equal(evaluateCondition(condition, event({ branch: "release/1.0/hotfix" }), project), true);
    assert.equal(evaluateCondition(condition, event({ branch: "feature/x" }), project), false);
  });

  it("pusher compares case-insensitively and never matches an unknown pusher", () => {
    const condition: RuleCondition = { type: "pusher", names: ["alice", "bob"] };
    assert.equal(evaluateCondition(condition, event({ pusher: "Alice" }), project), true);
    assert.equal(evaluateCondition(condition, event({ pusher: "carol" }), project), false);
    assert.equal(evaluateCondition(condition, event({ pusher: null }), project), false);
  });
});

describe("file conditions", () => {
  it("a pattern without a slash matches the file name at any depth", () => {
    assert.equal(matchesFilePattern("*.js", "a.js"), true);
    assert.equal(matchesFilePattern("*.js", "src/deep/a.js"), true);
    assert.equal(matchesFilePattern("*.js", "src/a.json"), false);
    assert.equal(matchesFilePattern("README.md", "docs/README.md"), true);
  });

  it("a pattern with a slash matches the path", () => {
    assert.equal(matchesFilePattern("src/*.ts", "src/a.ts"), true);
    assert.equal(matchesFilePattern("src/*.ts", "src/deep/a.ts"), false);
    assert.equal(matchesFilePattern("src/**", "src/deep/a.ts"), true);
    assert.equal(matchesFilePattern("docs/*.md", "src/docs/a.md"), false);
  });

  it("the condition holds when any changed file matches any pattern", () => {
    const condition: RuleCondition = { type: "file", patterns: ["*.py", "*.md"] };
    const files = [{ path: "src/a.ts", status: "modified" }, { path: "docs/guide.md", status: "added" }] as const;
    assert.equal(evaluateCondition(condition, event({ files: [...files] }), project), true);
    assert.equal(evaluateCondition(condition, event({ files: [files[0]] }), project), false);
    assert.equal(evaluateCondition(condition, event({ files: [] }), project), false);
  });
});

describe("time condition", () => {
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime(); // 2026-10-09 is a Friday
  const workHours: TimeCondition = { type: "time", from: "09:00", to: "18:00", days: [1, 2, 3, 4, 5], match: "inside" };

  it("inside working hours on weekdays", () => {
    assert.equal(matchesTime(workHours, at(9, 10)), true);
    assert.equal(matchesTime(workHours, at(9, 9, 0)), true, "start is inclusive");
    assert.equal(matchesTime(workHours, at(9, 18, 0)), false, "end is exclusive");
    assert.equal(matchesTime(workHours, at(9, 8, 59)), false);
    assert.equal(matchesTime(workHours, at(10, 10)), false, "Saturday");
  });

  it("'outside' is the exact complement", () => {
    const off: TimeCondition = { ...workHours, match: "outside" };
    for (const when of [at(9, 10), at(9, 20), at(10, 10), at(11, 12)]) {
      assert.equal(matchesTime(off, when), !matchesTime(workHours, when));
    }
  });

  it("supports windows that cross midnight", () => {
    const night: TimeCondition = { type: "time", from: "22:00", to: "06:00", days: [0, 1, 2, 3, 4, 5, 6], match: "inside" };
    assert.equal(matchesTime(night, at(9, 23)), true);
    assert.equal(matchesTime(night, at(9, 5, 59)), true);
    assert.equal(matchesTime(night, at(9, 12)), false);
  });

  it("identical start and end means the whole day", () => {
    const allDay: TimeCondition = { type: "time", from: "00:00", to: "00:00", days: [5], match: "inside" };
    assert.equal(matchesTime(allDay, at(9, 3)), true);
    assert.equal(matchesTime(allDay, at(10, 3)), false);
  });
});

describe("other conditions", () => {
  it("file_count compares with >= and <=", () => {
    assert.equal(evaluateCondition({ type: "file_count", op: "gte", value: 5 }, event({ fileCount: 5 }), project), true);
    assert.equal(evaluateCondition({ type: "file_count", op: "gte", value: 5 }, event({ fileCount: 4 }), project), false);
    assert.equal(evaluateCondition({ type: "file_count", op: "lte", value: 5 }, event({ fileCount: 5 }), project), true);
    assert.equal(evaluateCondition({ type: "file_count", op: "lte", value: 5 }, event({ fileCount: 6 }), project), false);
  });

  it("branch_violation, event_type and project", () => {
    assert.equal(evaluateCondition({ type: "branch_violation", value: true }, event({ branchViolation: true }), project), true);
    assert.equal(evaluateCondition({ type: "branch_violation", value: true }, event(), project), false);
    assert.equal(evaluateCondition({ type: "branch_violation", value: false }, event(), project), true);
    assert.equal(evaluateCondition({ type: "event_type", types: ["create", "delete"] }, event({ eventType: "push" }), project), false);
    assert.equal(evaluateCondition({ type: "event_type", types: ["create", "delete"] }, event({ eventType: "delete" }), project), true);
    assert.equal(evaluateCondition({ type: "project", projectIds: [3, 7] }, event(), project), true);
    assert.equal(evaluateCondition({ type: "project", projectIds: [3] }, event(), project), false);
  });
});

describe("evaluateRule", () => {
  const yes: RuleCondition = { type: "branch", patterns: ["main"] };
  const no: RuleCondition = { type: "branch", patterns: ["nope"] };

  it("'all' needs every condition, 'any' needs one", () => {
    assert.equal(evaluateRule({ matchMode: "all", conditions: [yes, yes] }, event(), project).matched, true);
    assert.equal(evaluateRule({ matchMode: "all", conditions: [yes, no] }, event(), project).matched, false);
    assert.equal(evaluateRule({ matchMode: "any", conditions: [yes, no] }, event(), project).matched, true);
    assert.equal(evaluateRule({ matchMode: "any", conditions: [no, no] }, event(), project).matched, false);
  });

  it("no conditions means no restriction, and each outcome is reported", () => {
    assert.equal(evaluateRule({ matchMode: "all", conditions: [] }, event(), project).matched, true);
    assert.equal(evaluateRule({ matchMode: "any", conditions: [] }, event(), project).matched, true);
    assert.deepEqual(evaluateRule({ matchMode: "all", conditions: [yes, no] }, event(), project).conditions, [
      { type: "branch", matched: true },
      { type: "branch", matched: false }
    ]);
  });
});
