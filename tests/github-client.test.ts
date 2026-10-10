import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GithubApiError, createGithubClient, type RateLimitInfo } from "@main/github/client";
import type { FetchFn } from "@main/github-token-check";
import { SecretMissingError } from "@main/vault/vault";
import { sha } from "./helpers/fake-github";

type Headers = Record<string, string>;
interface Scripted {
  status: number;
  headers?: Headers;
  body?: unknown;
  jsonError?: boolean;
}

const TOKEN = "github_pat_" + "11ABCDEFG0abcdefghij_klmnopqrstuvwxyzWXYZ";

const setup = (responses: Scripted[] | ((url: string) => Scripted), options: { now?: () => number } = {}) => {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const rateLimits: RateLimitInfo[] = [];
  let tokenReads = 0;
  let index = 0;

  const fetchFn: FetchFn = async (url, init) => {
    requests.push({ url, headers: init.headers });
    const scripted = typeof responses === "function" ? responses(url) : (responses[index++] as Scripted);
    const headers = Object.fromEntries(Object.entries(scripted.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: scripted.status,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      json: async () => {
        if (scripted.jsonError) {
          throw new Error("bad json");
        }
        return scripted.body;
      }
    };
  };

  const client = createGithubClient({
    fetchFn,
    withToken: async (fn) => {
      tokenReads += 1;
      return fn(TOKEN);
    },
    onRateLimit: (info) => rateLimits.push(info),
    now: options.now
  });
  return { client, requests, rateLimits, tokenReads: () => tokenReads };
};

const branchItem = (name: string, n: number) => ({ name, commit: { sha: sha(n) } });

describe("request shape", () => {
  it("sends the token only as a bearer header and reads it fresh for every request", async () => {
    const t = setup([
      { status: 200, body: { default_branch: "main" } },
      { status: 200, body: { default_branch: "main" } }
    ]);
    await t.client.getDefaultBranch("acme", "widgets");
    await t.client.getDefaultBranch("acme", "widgets");

    assert.equal(t.tokenReads(), 2);
    for (const request of t.requests) {
      assert.equal(request.url, "https://api.github.com/repos/acme/widgets");
      assert.equal(request.headers.Authorization, `Bearer ${TOKEN}`);
      assert.equal(request.headers["X-GitHub-Api-Version"], "2022-11-28");
      assert.equal(request.headers["User-Agent"], "gitnrun");
      assert.ok(!request.url.includes(TOKEN));
    }
  });

  it("rejects owner/repo names that could escape the path before any request is made", async () => {
    const t = setup([]);
    for (const [owner, repo] of [["..", "x"], ["acme", "../../user"], ["a/b", "c"], ["acme", "repo?x=1"], ["", "r"]] as const) {
      await assert.rejects(t.client.listBranches(owner, repo), (error) => error instanceof GithubApiError && error.kind === "invalid");
    }
    assert.equal(t.requests.length, 0);
  });

  it("rejects non-hex SHAs before any request is made", async () => {
    const t = setup([]);
    await assert.rejects(t.client.compare("acme", "widgets", "main", sha(1)));
    await assert.rejects(t.client.compare("acme", "widgets", sha(1), "../../x"));
    await assert.rejects(t.client.getCommit("acme", "widgets", "HEAD"));
    assert.equal(t.requests.length, 0);
  });
});

describe("listBranches", () => {
  it("returns heads and the ETag for a single page", async () => {
    const t = setup([{ status: 200, headers: { ETag: 'W/"abc"' }, body: [branchItem("main", 1), branchItem("dev", 2)] }]);
    const result = await t.client.listBranches("acme", "widgets");

    assert.deepEqual(result, {
      kind: "ok",
      branches: [{ name: "main", sha: sha(1) }, { name: "dev", sha: sha(2) }],
      etag: 'W/"abc"',
      truncated: false
    });
    assert.ok(t.requests[0]?.url.includes("per_page=100&page=1"));
    assert.equal(t.requests[0]?.headers["If-None-Match"], undefined);
  });

  it("sends If-None-Match and reports not-modified on 304", async () => {
    const t = setup([{ status: 304 }]);
    const result = await t.client.listBranches("acme", "widgets", 'W/"abc"');

    assert.deepEqual(result, { kind: "not-modified" });
    assert.equal(t.requests[0]?.headers["If-None-Match"], 'W/"abc"');
  });

  it("follows pagination and drops the ETag, since page 1 alone cannot vouch for later pages", async () => {
    const t = setup([
      { status: 200, headers: { etag: 'W/"p1"', link: '<https://api.github.com/x?page=2>; rel="next"' }, body: [branchItem("a", 1)] },
      { status: 200, headers: { etag: 'W/"p2"' }, body: [branchItem("b", 2)] }
    ]);
    const result = await t.client.listBranches("acme", "widgets", 'W/"p1"');

    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      assert.deepEqual(result.branches.map((branch) => branch.name), ["a", "b"]);
      assert.equal(result.etag, null);
    }
    // 第 2 頁不能帶 If-None-Match。
    assert.equal(t.requests[1]?.headers["If-None-Match"], undefined);
  });

  it("marks the listing truncated when the page cap is hit", async () => {
    const t = setup(() => ({
      status: 200,
      headers: { link: '<https://api.github.com/x?page=99>; rel="next"' },
      body: [branchItem("x", 1)]
    }));
    const result = await t.client.listBranches("acme", "widgets");

    assert.equal(result.kind === "ok" && result.truncated, true);
    assert.equal(t.requests.length, 20);
  });

  it("ignores malformed items", async () => {
    const t = setup([{ status: 200, body: [{ name: "ok", commit: { sha: sha(1) } }, { name: 5 }, null, { name: "x", commit: {} }] }]);
    const result = await t.client.listBranches("acme", "widgets");
    assert.equal(result.kind === "ok" && result.branches.length, 1);
  });
});

describe("error mapping", () => {
  const kindOf = async (scripted: Scripted, now?: () => number): Promise<GithubApiError> => {
    const t = setup([scripted], { now });
    try {
      await t.client.getDefaultBranch("acme", "widgets");
    } catch (error) {
      assert.ok(error instanceof GithubApiError);
      return error;
    }
    throw new Error("expected an error");
  };

  it("maps status codes to kinds", async () => {
    assert.equal((await kindOf({ status: 401 })).kind, "auth");
    assert.equal((await kindOf({ status: 404 })).kind, "not-found");
    assert.equal((await kindOf({ status: 502 })).kind, "server");
    assert.equal((await kindOf({ status: 418 })).kind, "invalid");
    assert.equal((await kindOf({ status: 200, jsonError: true })).kind, "invalid");
    assert.equal((await kindOf({ status: 200, body: {} })).kind, "invalid");
  });

  it("distinguishes rate limiting from a plain 403", async () => {
    const forbidden = await kindOf({ status: 403, headers: { "x-ratelimit-remaining": "42" } });
    assert.equal(forbidden.kind, "forbidden");

    const limited = await kindOf(
      { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000" } },
      () => 1_500_000
    );
    assert.equal(limited.kind, "rate-limited");
    assert.equal(limited.retryAfterMs, 500_000);

    const retryAfter = await kindOf({ status: 429, headers: { "retry-after": "30" } });
    assert.equal(retryAfter.kind, "rate-limited");
    assert.equal(retryAfter.retryAfterMs, 30_000);
  });

  it("turns a thrown fetch into a network error that carries no request details", async () => {
    const client = createGithubClient({
      fetchFn: async () => {
        throw new Error(`connect ECONNRESET with Bearer ${TOKEN}`);
      },
      withToken: (fn) => fn(TOKEN)
    });
    await assert.rejects(client.getDefaultBranch("acme", "widgets"), (error) => {
      assert.ok(error instanceof GithubApiError);
      assert.equal(error.kind, "network");
      assert.ok(!error.message.includes(TOKEN));
      return true;
    });
  });

  it("lets vault errors through so 'no token' is not mistaken for a network problem", async () => {
    const client = createGithubClient({
      fetchFn: async () => {
        throw new Error("never reached");
      },
      withToken: async () => {
        throw new SecretMissingError("github.pat");
      }
    });
    await assert.rejects(client.getDefaultBranch("acme", "widgets"), SecretMissingError);
  });
});

describe("rate limit reporting", () => {
  it("reports remaining quota and reset time from response headers", async () => {
    const t = setup([
      { status: 200, headers: { "x-ratelimit-remaining": "4321", "x-ratelimit-reset": "1700000000" }, body: { default_branch: "main" } }
    ]);
    await t.client.getDefaultBranch("acme", "widgets");
    assert.deepEqual(t.rateLimits, [{ remaining: 4321, resetAt: 1_700_000_000_000 }]);
  });
});

describe("compare and getCommit", () => {
  const apiCommit = (n: number, message: string, login: string | null = "octocat") => ({
    sha: sha(n),
    commit: { message, author: { name: "Name", date: "2026-10-09T01:02:03Z" }, committer: { date: "2026-10-09T01:02:04Z" } },
    author: login === null ? null : { login }
  });

  it("parses commits (oldest first) and maps file statuses", async () => {
    const t = setup([
      {
        status: 200,
        body: {
          total_commits: 2,
          commits: [apiCommit(1, "feat: a"), apiCommit(2, "fix: b", null)],
          files: [
            { filename: "a.ts", status: "added" },
            { filename: "b.ts", status: "modified" },
            { filename: "c.ts", status: "removed" },
            { filename: "d.ts", status: "renamed", previous_filename: "old.ts" },
            { filename: "e.ts", status: "copied" },
            { filename: "f.ts", status: "changed" }
          ]
        }
      }
    ]);
    const result = await t.client.compare("acme", "widgets", sha(10), sha(11));

    assert.equal(result.totalCommits, 2);
    assert.deepEqual(result.commits.map((c) => [c.sha, c.author]), [[sha(1), "octocat"], [sha(2), "Name"]]);
    assert.equal(result.commits[0]?.timestamp, Date.parse("2026-10-09T01:02:04Z"));
    assert.deepEqual(result.files.map((f) => f.status), ["added", "modified", "removed", "renamed", "added", "modified"]);
    assert.equal(result.files[3]?.previousPath, "old.ts");
    assert.ok(t.requests[0]?.url.endsWith(`/compare/${sha(10)}...${sha(11)}?per_page=100`));
  });

  it("keeps only the newest 50 commits", async () => {
    const commits = Array.from({ length: 80 }, (_, i) => apiCommit(i + 1, `c${i + 1}`));
    const t = setup([{ status: 200, body: { total_commits: 80, commits, files: [] } }]);
    const result = await t.client.compare("acme", "widgets", sha(100), sha(101));

    assert.equal(result.commits.length, 50);
    assert.equal(result.commits[49]?.sha, sha(80));
    assert.equal(result.totalCommits, 80);
  });

  it("returns a single commit with its files", async () => {
    const t = setup([{ status: 200, body: { ...apiCommit(7, "chore: x"), files: [{ filename: "z.md", status: "modified" }] } }]);
    const result = await t.client.getCommit("acme", "widgets", sha(7));

    assert.equal(result.sha, sha(7));
    assert.deepEqual(result.files, [{ path: "z.md", status: "modified" }]);
  });
});
