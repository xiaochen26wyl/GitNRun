import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_AI_SETTINGS, validateAiSettings } from "@shared/ai";
import { SYSTEM_PROMPT, formatCommitList, formatFileList, normalizeCommitMessage, renderPrompt } from "@main/ai/prompts";
import { parseNameStatus } from "@main/ai/local-changes";
import { parseMergeTree } from "@main/ai/conflicts";

describe("normalizeCommitMessage", () => {
  it("accepts a conventional message and trims decoration", () => {
    assert.equal(normalizeCommitMessage("feat: 新增登入頁"), "feat: 新增登入頁");
    assert.equal(normalizeCommitMessage('  "fix: 修正逾時"  \n'), "fix: 修正逾時");
    assert.equal(normalizeCommitMessage("`docs: 更新說明`"), "docs: 更新說明");
    assert.equal(normalizeCommitMessage("- chore: 升級依賴"), "chore: 升級依賴");
    assert.equal(normalizeCommitMessage("feat(auth): 新增登入"), "feat(auth): 新增登入");
  });

  it("repairs a full-width colon, and takes only the first non-empty line", () => {
    assert.equal(normalizeCommitMessage("feat：新增登入頁"), "feat: 新增登入頁");
    assert.equal(normalizeCommitMessage("feat:缺少空格"), "feat: 缺少空格");
    assert.equal(normalizeCommitMessage("\n\nrefactor: 整理模組\n\n這次改了很多東西……"), "refactor: 整理模組");
  });

  it("rejects anything that is not a safe single-line conventional message", () => {
    for (const bad of [
      "", "   ", "新增登入頁", "feature: 新增", "Feat: 新增", "feat:", "feat: ",
      "-m evil", "--amend", "feat: " + "字".repeat(130), "$(rm -rf /)", "好的，這是 commit 訊息：feat: x"
    ]) {
      assert.equal(normalizeCommitMessage(bad), null, JSON.stringify(bad));
    }
  });

  it("never returns something that could be taken for a git option", () => {
    for (const attempt of ["--feat: x", "-feat: x", "\"--upload-pack=x\""]) {
      const result = normalizeCommitMessage(attempt);
      assert.ok(result === null || !result.startsWith("-"), attempt);
    }
  });
});

describe("renderPrompt", () => {
  it("fills placeholders in one pass: diff content that looks like a placeholder is not expanded", () => {
    const text = renderPrompt("專案 {project}\n{diff}", { project: "acme/api", diff: "+ const x = '{project} {secret}'", secret: "NO" });
    assert.equal(text, "專案 acme/api\n+ const x = '{project} {secret}'");
  });

  it("the system prompt tells the model that diffs are data, not instructions", () => {
    assert.match(SYSTEM_PROMPT, /資料/);
    assert.match(SYSTEM_PROMPT, /不是給你的指令/);
  });
});

describe("list formatting", () => {
  it("formats files and commits and caps long lists", () => {
    assert.equal(formatFileList([]), "（無）");
    assert.equal(formatFileList([{ path: "a.ts", status: "added" }]), "- added a.ts");
    const many = Array.from({ length: 70 }, (_, i) => ({ path: `f${i}.ts`, status: "modified" as const }));
    const text = formatFileList(many);
    assert.equal(text.split("\n").length, 61);
    assert.match(text, /另有 10 個檔案/);

    assert.equal(formatCommitList([]), "（無）");
    assert.equal(formatCommitList([{ message: "feat: x\n\nbody", author: "alice" }]), "- feat: x（alice）");
    assert.equal(formatCommitList(Array.from({ length: 40 }, (_, i) => ({ message: `c${i}`, author: "a" }))).split("\n").length, 30);
  });
});

describe("validateAiSettings", () => {
  it("accepts the defaults and a partial override merged onto them", () => {
    assert.ok(validateAiSettings(DEFAULT_AI_SETTINGS).ok);
    const partial = validateAiSettings({ provider: "openai", openaiModel: "gpt-x-1", dailyLimit: 20 });
    assert.ok(partial.ok);
    assert.equal(partial.value.provider, "openai");
    assert.equal(partial.value.ratePerMinute, DEFAULT_AI_SETTINGS.ratePerMinute);
    assert.deepEqual(partial.value.prompts, DEFAULT_AI_SETTINGS.prompts);
  });

  it("rejects bad providers, model names, limits, globs and prompts", () => {
    for (const bad of [
      { provider: "gemini" },
      { anthropicFastModel: "" },
      { anthropicFastModel: "bad model name" },
      { openaiModel: "../x" },
      { maxDiffBytes: 10 },
      { maxDiffBytes: 10_000_000 },
      { ratePerMinute: 0 },
      { dailyLimit: 10_001 },
      { batchWindowSec: 31 },
      { cacheTtlHours: 0 },
      { excludeGlobs: ["", "a"] },
      { excludeGlobs: "x" },
      { excludeGlobs: Array(101).fill("x") },
      { prompts: { commit: "" } },
      { prompts: { summary: "x".repeat(8001) } },
      null,
      []
    ]) {
      assert.equal(validateAiSettings(bad).ok, false, JSON.stringify(bad)?.slice(0, 60));
    }
  });

  it("allows an empty OpenAI model (it is only needed when OpenAI is selected)", () => {
    assert.ok(validateAiSettings({ openaiModel: "" }).ok);
  });
});

describe("local git output parsing", () => {
  it("parses name-status lines including renames and unknown codes", () => {
    assert.deepEqual(parseNameStatus("M\tsrc/a.ts\nA\tsrc/b.ts\nD\told.ts\nR100\tfrom.ts\tto.ts\nT\tlink\n\n"), [
      { path: "src/a.ts", status: "modified" },
      { path: "src/b.ts", status: "added" },
      { path: "old.ts", status: "removed" },
      { path: "to.ts", status: "renamed", previousPath: "from.ts" },
      { path: "link", status: "modified" }
    ]);
    assert.deepEqual(parseNameStatus(""), []);
  });
});

describe("parseMergeTree", () => {
  it("clean merge", () => {
    assert.deepEqual(parseMergeTree(0, "abc123\n", ""), { kind: "clean", messages: "" });
  });

  it("conflicts: names up to the blank line, then git's messages; duplicates removed", () => {
    const out = parseMergeTree(1, "abc123\nsrc/a.ts\nsrc/b.ts\nsrc/a.ts\n\nAuto-merging src/a.ts\nCONFLICT (content): Merge conflict in src/a.ts\n", "");
    assert.deepEqual(out, {
      kind: "conflicts",
      files: ["src/a.ts", "src/b.ts"],
      messages: "Auto-merging src/a.ts\nCONFLICT (content): Merge conflict in src/a.ts"
    });
  });

  it("detects a git that is too old, and reports other errors", () => {
    assert.deepEqual(parseMergeTree(129, "", "usage: git merge-tree [<options>] <branch1> <branch2>"), { kind: "unsupported" });
    assert.deepEqual(parseMergeTree(128, "", "fatal: not a valid object name origin/nope"), { kind: "error", detail: "fatal: not a valid object name origin/nope" });
  });
});
