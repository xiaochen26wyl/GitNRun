import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rankByChangedFiles, type GitLiteProject } from "@shared/git-lite";
import { createGitLiteHandlers } from "@main/git-lite/handlers";
import { addRunFolder } from "@main/run/store";
import { createVault } from "@main/vault/vault";
import type { GitResult } from "@main/git/run-git";
import { createTestDb } from "./helpers/db";
import { createFakeCipher } from "./helpers/fake-cipher";

const result = (stdout = "", code = 0): GitResult => ({ code, stdout, stderr: "", timedOut: false });

const githubRepoGit = async (_cwd: string, args: readonly string[]): Promise<GitResult> => {
  const command = args.join(" ");
  if (command === "rev-parse --is-inside-work-tree") return result("true\n");
  if (command === "branch --show-current") return result("main\n");
  if (command === "remote get-url origin") return result("git@github.com:acme/widgets.git\n");
  return result("", 1);
};

/** 產生 GitHub issues API 的原始回傳：前 pullRequests 筆帶 pull_request 欄位。 */
const issueItems = (count: number, pullRequests = 0) =>
  Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    number: index + 1,
    title: `Issue ${index + 1}`,
    html_url: `https://github.com/acme/widgets/issues/${index + 1}`,
    user: { login: "octo" },
    updated_at: "2026-01-02T03:04:05Z",
    ...(index < pullRequests ? { pull_request: {} } : {})
  }));

/** setup 會取代預設的「已設定 token」；傳 () => undefined 代表完全不設定 token。 */
const readFirstProject = async (
  fetchFn: typeof fetch,
  setup?: (context: { vault: ReturnType<typeof createVault>; cipher: ReturnType<typeof createFakeCipher> }) => void
) => {
  const db = createTestDb();
  addRunFolder(db, "/work/app");
  const cipher = createFakeCipher();
  const vault = createVault(db, cipher);
  if (setup) setup({ vault, cipher });
  else vault.set("github.pat", "github_pat_1234567890abcdef");
  const overview = await createGitLiteHandlers({ db, vault, runGit: githubRepoGit, fetchFn }).overview();
  return overview.projects[0];
};

const respond = (status: number, body: unknown = []): typeof fetch => async () => new Response(JSON.stringify(body), { status });

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
        if (command === "status --porcelain=v1 --untracked-files=all") return result(" M src/a.ts\nA  src/b.ts\n?? notes.md\n");
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

  it("includes repos found under the project root and dedupes against added folders", async () => {
    const db = createTestDb();
    addRunFolder(db, "/work/app");
    const handlers = createGitLiteHandlers({
      db,
      vault: createVault(db, createFakeCipher()),
      runGit: async () => result("", 1),
      fetchFn: async () => {
        throw new Error("should not fetch");
      },
      discoverRepoFolders: () => ["/work/alpha", "/work/app/", "/work/beta"]
    });

    const overview = await handlers.overview();

    assert.deepEqual(
      overview.projects.map((project) => [project.label, project.folder]),
      [
        ["app", "/work/app"],
        ["alpha", "/work/alpha"],
        ["beta", "/work/beta"]
      ]
    );
    assert.equal(new Set(overview.projects.map((project) => project.id)).size, 3);
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

  it("flags a full page of results as truncated, counting before pull requests are filtered out", async () => {
    const full = await readFirstProject(respond(200, issueItems(20, 3)));
    assert.equal(full?.issues.length, 17);
    assert.equal(full?.issuesTruncated, true);
    assert.equal(full?.issueErrorKind, null);

    const partial = await readFirstProject(respond(200, issueItems(19)));
    assert.equal(partial?.issues.length, 19);
    assert.equal(partial?.issuesTruncated, false);

    const empty = await readFirstProject(respond(200, []));
    assert.deepEqual(empty?.issues, []);
    assert.equal(empty?.issuesTruncated, false);
    assert.equal(empty?.issueError, null);
  });

  it("classifies issue read failures without changing the messages", async () => {
    const cases: Array<[string, typeof fetch, string, string]> = [
      ["401", respond(401), "token-rejected", "GitHub token 無法讀取 issues"],
      ["403", respond(403), "token-rejected", "GitHub token 無法讀取 issues"],
      ["404", respond(404), "not-found", "找不到 GitHub repo 或沒有權限"],
      ["500", respond(500), "http", "GitHub 回應 HTTP 500"],
      [
        "network",
        async () => {
          throw new TypeError("fetch failed");
        },
        "network",
        "無法連線到 GitHub"
      ]
    ];
    for (const [name, fetchFn, kind, message] of cases) {
      const project = await readFirstProject(fetchFn);
      assert.equal(project?.issueErrorKind, kind, name);
      assert.equal(project?.issueError, message, name);
      assert.deepEqual(project?.issues, [], name);
      assert.equal(project?.issuesTruncated, false, name);
    }
  });

  it("reports a missing or unreadable token as the no-token kind", async () => {
    const noFetch: typeof fetch = async () => {
      throw new Error("should not fetch");
    };
    const missing = await readFirstProject(noFetch, () => undefined);
    assert.equal(missing?.issueErrorKind, "no-token");
    assert.equal(missing?.issueError, "尚未設定 GitHub token");

    const unreadable = await readFirstProject(noFetch, ({ vault, cipher }) => {
      vault.set("github.pat", "github_pat_1234567890abcdef");
      cipher.decrypt = () => {
        throw new Error("cannot decrypt");
      };
    });
    assert.equal(unreadable?.issueErrorKind, "no-token");
    assert.equal(unreadable?.issueError, "GitHub token 無法解密，請重新輸入");
  });

  it("leaves the issue fields at their defaults when origin is not a GitHub remote", async () => {
    const db = createTestDb();
    addRunFolder(db, "/work/app");
    const handlers = createGitLiteHandlers({
      db,
      vault: createVault(db, createFakeCipher()),
      runGit: async (_cwd, args) => {
        const command = args.join(" ");
        if (command === "rev-parse --is-inside-work-tree") return result("true\n");
        if (command === "remote get-url origin") return result("git@gitlab.com:acme/widgets.git\n");
        return result("", 1);
      },
      fetchFn: async () => {
        throw new Error("should not fetch");
      }
    });

    const project = (await handlers.overview()).projects[0];

    assert.equal(project?.repo, null);
    assert.deepEqual(project?.issues, []);
    assert.equal(project?.issuesTruncated, false);
    assert.equal(project?.issueError, null);
    assert.equal(project?.issueErrorKind, null);
  });

  it("never asks GitHub for the issues of projects in the skipped groups, but still reports their git state", async () => {
    const db = createTestDb();
    addRunFolder(db, "/work/GitNRun");
    addRunFolder(db, "/work/Usage-Pulse");
    addRunFolder(db, "/work/socialHub");
    addRunFolder(db, "/work/app");
    const vault = createVault(db, createFakeCipher());
    vault.set("github.pat", "github_pat_1234567890abcdef");
    const fetched: string[] = [];
    const handlers = createGitLiteHandlers({
      db,
      vault,
      runGit: githubRepoGit,
      fetchFn: async (input) => {
        fetched.push(String(input));
        return new Response(JSON.stringify(issueItems(2)), { status: 200 });
      }
    });

    const projects = (await handlers.overview()).projects;
    const skipped = projects.find((project) => project.folder === "/work/GitNRun");
    const normal = projects.find((project) => project.folder === "/work/app");

    assert.equal(skipped?.isGitRepo, true);
    assert.equal(skipped?.branch, "main");
    assert.deepEqual(skipped?.repo, { owner: "acme", repo: "widgets", url: "https://github.com/acme/widgets" });
    assert.deepEqual(skipped?.issues, []);
    assert.equal(skipped?.issuesTruncated, false);
    assert.equal(skipped?.issueError, null);
    assert.equal(skipped?.issueErrorKind, null);
    for (const folder of ["/work/Usage-Pulse", "/work/socialHub"]) {
      const other = projects.find((project) => project.folder === folder);
      assert.equal(other?.isGitRepo, true, folder);
      assert.deepEqual(other?.issues, [], folder);
      assert.equal(other?.issueErrorKind, null, folder);
    }
    assert.equal(normal?.issues.length, 2);
    assert.equal(fetched.length, 1);
  });

  it("reads only local git state, with no GitHub request, when issues are switched off", async () => {
    const db = createTestDb();
    addRunFolder(db, "/work/app");
    const vault = createVault(db, createFakeCipher());
    vault.set("github.pat", "github_pat_1234567890abcdef");
    const handlers = createGitLiteHandlers({
      db,
      vault,
      runGit: async (_cwd, args) =>
        args[0] === "status" ? result("?? a.ts\n?? b.ts\n") : githubRepoGit(_cwd, args),
      fetchFn: async () => {
        throw new Error("should not fetch");
      }
    });

    const overview = await handlers.overview({ issues: false });
    const project = overview.projects[0];

    assert.equal(overview.githubTokenConfigured, true);
    assert.equal(project?.isGitRepo, true);
    assert.equal(project?.changedFiles, 2);
    assert.deepEqual(project?.repo, { owner: "acme", repo: "widgets", url: "https://github.com/acme/widgets" });
    assert.deepEqual(project?.issues, []);
    assert.equal(project?.issueError, null);
    assert.equal(project?.issueErrorKind, null);
  });

  it("asks git to list untracked files one by one so a new folder counts every file", async () => {
    const db = createTestDb();
    addRunFolder(db, "/work/app");
    const statusCalls: Array<readonly string[]> = [];
    const handlers = createGitLiteHandlers({
      db,
      vault: createVault(db, createFakeCipher()),
      runGit: async (cwd, args) => {
        if (args[0] === "status") {
          statusCalls.push(args);
          return result("?? docs/a.md\n?? docs/b.md\n?? docs/c.md\n");
        }
        return githubRepoGit(cwd, args);
      },
      fetchFn: async () => new Response("[]", { status: 200 })
    });

    const project = (await handlers.overview({ issues: false })).projects[0];

    assert.deepEqual(statusCalls, [["status", "--porcelain=v1", "--untracked-files=all"]]);
    assert.equal(project?.changedFiles, 3);
    assert.equal(project?.untrackedFiles, 3);
  });

  it("flags an unreadable git status instead of reporting zero changes", async () => {
    const db = createTestDb();
    addRunFolder(db, "/work/app");
    const handlers = createGitLiteHandlers({
      db,
      vault: createVault(db, createFakeCipher()),
      runGit: async (cwd, args) => (args[0] === "status" ? result("", 128) : githubRepoGit(cwd, args)),
      fetchFn: async () => new Response("[]", { status: 200 })
    });

    const project = (await handlers.overview({ issues: false })).projects[0];

    assert.equal(project?.isGitRepo, true);
    assert.equal(project?.changedFiles, 0);
    assert.equal(project?.statusError, "無法讀取 git 狀態");
  });

  it("ranks projects by changed file count, non-git last", () => {
    const make = (label: string, changedFiles: number, untrackedFiles = 0, isGitRepo = true): GitLiteProject => ({
      id: label, label, folder: `/w/${label}`, source: "folder", isGitRepo, branch: null, upstream: null,
      ahead: 0, behind: 0, changedFiles, stagedFiles: 0, unstagedFiles: 0, untrackedFiles,
      repo: null, issues: [], issuesTruncated: false, statusError: null, issueError: null, issueErrorKind: null
    });
    const input = [make("plain", 0, 0, false), make("b", 2), make("a", 5), make("c", 2, 3)];
    assert.deepEqual(rankByChangedFiles(input).map((p) => p.label), ["a", "c", "b", "plain"]);
    assert.equal(input[0]?.label, "plain");
  });
});
