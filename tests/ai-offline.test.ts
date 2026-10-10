import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChangedFile } from "@shared/events";
import { inferCommitType, offlineCommitMessage, offlineSuggestion, offlineSummary } from "@main/ai/offline";

const file = (path: string, status: ChangedFile["status"] = "modified"): ChangedFile => ({ path, status });

describe("inferCommitType", () => {
  it("recognises docs, tests, styles and config-only changes", () => {
    assert.equal(inferCommitType([file("README.md"), file("docs/guide.md")]), "docs");
    assert.equal(inferCommitType([file("tests/a.test.ts"), file("src/b.spec.ts")]), "test");
    assert.equal(inferCommitType([file("src/app.css")]), "style");
    assert.equal(inferCommitType([file("package.json"), file("pnpm-lock.yaml")]), "chore");
    assert.equal(inferCommitType([file(".github/workflows/ci.yml")]), "chore");
    assert.equal(inferCommitType([file("vite.config.ts")]), "chore");
  });

  it("calls it a feature only when files were added and nothing removed, otherwise stays neutral", () => {
    assert.equal(inferCommitType([file("src/new.ts", "added"), file("src/old.ts")]), "feat");
    assert.equal(inferCommitType([file("src/new.ts", "added"), file("src/old.ts", "removed")]), "chore");
    assert.equal(inferCommitType([file("src/a.ts"), file("src/b.ts")]), "chore");
    assert.equal(inferCommitType([]), "chore");
  });
});

describe("offlineCommitMessage", () => {
  it("is always '<type>: <Traditional Chinese sentence>'", () => {
    const messages = [
      offlineCommitMessage([file("README.md")]),
      offlineCommitMessage([file("src/login.ts", "added")]),
      offlineCommitMessage([file("src/a.ts"), file("src/b.ts"), file("src/c.ts")]),
      offlineCommitMessage([file("src/a.ts", "added"), file("src/b.ts")]),
      offlineCommitMessage([])
    ];
    for (const message of messages) {
      assert.match(message, /^(feat|fix|chore|docs|refactor|style|test): .+/, message);
    }
    assert.equal(messages[0], "docs: 修改 README.md");
    assert.equal(messages[1], "feat: 新增 login.ts");
    assert.equal(messages[2], "chore: 修改 a.ts 等 3 個檔案");
    assert.equal(messages[3], "feat: 更新 a.ts 等 2 個檔案");
  });
});

describe("offlineSummary", () => {
  const base = { pusher: "alice", pusherInferred: true, branch: "main", eventType: "push" as const, headMessage: "feat: login", commits: [{}, {}] as never[], files: [file("a.ts", "added"), file("b.ts"), file("c.ts", "removed")], fileCount: 3 };

  it("says who pushed what and how big it was", () => {
    assert.equal(offlineSummary(base), "alice（推定）推送2 個 commit 到 main，變更 3 個檔案（新增 1、修改 1、刪除 1）：feat: login");
  });

  it("handles creation, deletion and unknown pushers", () => {
    assert.match(offlineSummary({ ...base, eventType: "create" }), /建立了新分支並推送/);
    assert.equal(offlineSummary({ ...base, eventType: "delete" }), "分支 main 已被刪除。");
    assert.match(offlineSummary({ ...base, pusher: null, commits: [], files: [], fileCount: 0, headMessage: "" }), /^有人推送到 main$/);
  });
});

describe("offlineSuggestion", () => {
  const base = { branch: "main", branchViolation: false, fileCount: 2, files: [file("src/a.ts")], eventType: "push" as const };

  it("flags naming violations, big pushes and risky files", () => {
    const text = offlineSuggestion({ ...base, branchViolation: true, fileCount: 40, files: [file(".github/workflows/ci.yml"), file("package.json"), file("src/a.ts")] });
    assert.match(text, /命名規則/);
    assert.match(text, /40 個檔案/);
    assert.match(text, /\.github\/workflows\/ci\.yml/);
    assert.match(text, /package\.json/);
  });

  it("does not claim a change is safe when it has only looked at paths", () => {
    const text = offlineSuggestion(base);
    assert.match(text, /不看內容/);
    assert.ok(!/可以合併|安全/.test(text));
  });

  it("notes test-only pushes and deletions", () => {
    assert.match(offlineSuggestion({ ...base, files: [file("tests/a.test.ts")] }), /只有測試檔案/);
    assert.match(offlineSuggestion({ ...base, eventType: "delete" }), /已刪除/);
  });
});
