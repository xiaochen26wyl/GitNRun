import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGitLiteHandlers } from "@main/git-lite/handlers";
import { addRunFolder } from "@main/run/store";
import { createVault } from "@main/vault/vault";
import type { GitResult } from "@main/git/run-git";
import { createTestDb } from "./helpers/db";
import { createFakeCipher } from "./helpers/fake-cipher";

const result = (stdout = "", code = 0): GitResult => ({ code, stdout, stderr: "", timedOut: false });

describe("git-lite handlers", () => {
  it("summarises read-only local git state and GitHub issues", async () => {
    const db = createTestDb();
    addRunFolder(db, "/work/app");
    const vault = createVault(db, createFakeCipher());
    vault.set("github.pat", "github_pat_1234567890abcdef");
    const calls: Array<{ cwd: string; args: readonly string[] }> = [];
    const handlers = createGitLiteHandlers({
      db,
      vault,
      runGit: async (cwd, args) => {
        calls.push({ cwd, args });
        const command = args.join(" ");
        if (command === "rev-parse --is-inside-work-tree") return result("true\n");
        if (command === "branch --show-current") return result("main\n");
        if (command === "rev-parse --abbrev-ref --symbolic-full-name @{u}") return result("origin/main\n");
        if (command === "rev-list --left-right --count HEAD...@{u}") return result("3\t1\n");
        if (command === "status --porcelain=v1") return result(" M src/a.ts\nA  src/b.ts\n?? notes.md\n");
        if (command === "remote get-url origin") return result("git@github.com:acme/widgets.git\n");
        return result("", 1);
      },
      fetchFn: async () =>
        new Response(
          JSON.stringify([
            { id: 1, number: 7, title: "Fix login", html_url: "https://github.com/acme/widgets/issues/7", user: { login: "octo" }, updated_at: "2026-01-02T03:04:05Z" },
            { id: 2, number: 8, title: "PR", html_url: "https://github.com/acme/widgets/pull/8", user: { login: "octo" }, updated_at: "2026-01-02T03:04:05Z", pull_request: {} }
          ]),
          { status: 200 }
        )
    });

    const overview = await handlers.overview();

    assert.equal(overview.githubTokenConfigured, true);
    assert.equal(overview.projects[0]?.branch, "main");
    assert.equal(overview.projects[0]?.ahead, 3);
    assert.equal(overview.projects[0]?.behind, 1);
    assert.equal(overview.projects[0]?.changedFiles, 3);
    assert.equal(overview.projects[0]?.unstagedFiles, 1);
    assert.equal(overview.projects[0]?.stagedFiles, 1);
    assert.equal(overview.projects[0]?.untrackedFiles, 1);
    assert.deepEqual(overview.projects[0]?.repo, { owner: "acme", repo: "widgets", url: "https://github.com/acme/widgets" });
    assert.deepEqual(overview.projects[0]?.issues.map((issue) => [issue.number, issue.title]), [[7, "Fix login"]]);
    assert.ok(calls.every((call) => call.cwd === "/work/app"));
  });

  it("reports non-git folders and skips issues when no token is configured", async () => {
    const db = createTestDb();
    addRunFolder(db, "/work/plain");
    const handlers = createGitLiteHandlers({
      db,
      vault: createVault(db, createFakeCipher()),
      runGit: async () => result("", 1),
      fetchFn: async () => {
        throw new Error("should not fetch");
      }
    });

    const overview = await handlers.overview();

    assert.equal(overview.githubTokenConfigured, false);
    assert.equal(overview.projects[0]?.isGitRepo, false);
    assert.equal(overview.projects[0]?.statusError, "不是 git repo");
    assert.deepEqual(overview.projects[0]?.issues, []);
  });
});
