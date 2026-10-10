import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expandGitArgs } from "@main/exec/git-args";

const event = { branch: "feature/login", afterSha: "a".repeat(40), beforeSha: "b".repeat(40) };

describe("expandGitArgs", () => {
  it("passes ordinary arguments through untouched", () => {
    assert.deepEqual(expandGitArgs(["--ff-only", "origin", "main"], event), { ok: true, args: ["--ff-only", "origin", "main"] });
    assert.deepEqual(expandGitArgs([], event), { ok: true, args: [] });
  });

  it("substitutes the event's branch and SHAs once they are validated", () => {
    assert.deepEqual(expandGitArgs(["origin", "{branch}"], event), { ok: true, args: ["origin", "feature/login"] });
    assert.deepEqual(expandGitArgs(["refs/heads/{branch}:refs/heads/{branch}"], event), { ok: true, args: ["refs/heads/feature/login:refs/heads/feature/login"] });
    assert.deepEqual(expandGitArgs(["{before_sha}..{sha}"], event), { ok: true, args: [`${"b".repeat(40)}..${"a".repeat(40)}`] });
  });

  it("refuses to substitute a hostile or malformed branch name", () => {
    for (const branch of ["--upload-pack=touch pwned", "-x", "a b", "a..b", "has\nnewline", "ext::sh -c evil", "a~b", "a^b", ""]) {
      assert.equal(expandGitArgs(["{branch}"], { ...event, branch }).ok, false, JSON.stringify(branch));
    }
  });

  it("shell metacharacters that git itself allows in a branch name are harmless: they reach git as one literal argument", () => {
    // `;`、`$`、`&` 在 git 分支名稱裡是合法的；因為整個參數直接交給 git（不經 shell），不會被當成指令。
    for (const branch of ["x;rm", "a$b", "a&b", "a|b", "a`b`"]) {
      assert.deepEqual(expandGitArgs(["{branch}"], { ...event, branch }), { ok: true, args: [branch] }, branch);
    }
  });

  it("never lets event content turn a plain argument into an option", () => {
    const result = expandGitArgs(["{sha}"], { ...event, afterSha: "-" + "a".repeat(39) });
    assert.equal(result.ok, false);
    // 範本本身就以 "-" 開頭的選項則沒問題，例如 --branch={branch}。
    assert.deepEqual(expandGitArgs(["--set-upstream-to=origin/{branch}"], event), { ok: true, args: ["--set-upstream-to=origin/feature/login"] });
  });

  it("requires well-formed SHAs, and a before-SHA that exists", () => {
    assert.equal(expandGitArgs(["{sha}"], { ...event, afterSha: "nothex" }).ok, false);
    assert.equal(expandGitArgs(["{before_sha}"], { ...event, beforeSha: null }).ok, false);
  });

  it("rejects options that run programs or write arbitrary files", () => {
    for (const bad of [
      "--upload-pack=touch /tmp/x", "--upload-pack", "--receive-pack=evil", "--exec=evil", "--exec-path=/tmp",
      "--git-dir=/tmp/.git", "--work-tree=/", "--config=core.sshCommand=evil", "--config-env=a=B", "--output=/tmp/out", "--ext-cmd=x"
    ]) {
      assert.equal(expandGitArgs([bad], event).ok, false, bad);
    }
  });

  it("rejects external-command transports", () => {
    assert.equal(expandGitArgs(["ext::sh -c 'touch /tmp/x'"], event).ok, false);
    assert.equal(expandGitArgs(["fd::3"], event).ok, false);
    assert.equal(expandGitArgs(["EXT::sh"], event).ok, false);
  });

  it("still allows normal short options and force flags the user chose", () => {
    assert.equal(expandGitArgs(["-u", "origin", "{branch}"], event).ok, true);
    assert.equal(expandGitArgs(["-C", "HEAD"], event).ok, true, "git commit -C <commit> is legitimate");
    assert.equal(expandGitArgs(["--force-with-lease"], event).ok, true);
    assert.equal(expandGitArgs(["-m", "chore: sync $(not run) `not run`"], event).ok, true, "a commit message is just text");
  });

  it("rejects empty, over-long and multi-line arguments", () => {
    assert.equal(expandGitArgs([""], event).ok, false);
    assert.equal(expandGitArgs(["x".repeat(501)], event).ok, false);
    assert.equal(expandGitArgs(["a\nb"], event).ok, false);
    assert.equal(expandGitArgs(["a\0b"], event).ok, false);
  });
});
