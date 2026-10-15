import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BRAND_README_MAX_BYTES, createBrandHandlers, readBrandColor, readBrandColors, type BrandFs } from "@main/brand/handlers";

const readme = (color: string): string => `## 品牌配色\n\n### 主要配色\n\n| 角色 | 色碼 |\n|---|---|\n| 主色 | \`${color}\` |\n`;

type Entry = { kind: "file"; content: string; size?: number } | { kind: "link"; target: string } | { kind: "dir" };

/** 記憶體內的假檔案系統：key 是完整路徑，資料夾要明確宣告。 */
const fakeFs = (entries: Record<string, Entry>, failReadFor: readonly string[] = []): BrandFs => {
  const resolve = (path: string): string => {
    const entry = entries[path];
    return entry?.kind === "link" ? entry.target : path;
  };
  return {
    async readDir(path) {
      if (entries[path]?.kind !== "dir") {
        return null;
      }
      const prefix = path === "/" ? "/" : `${path}/`;
      return Object.keys(entries)
        .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
        .map((key) => key.slice(prefix.length));
    },
    async lstat(path) {
      const entry = entries[path];
      if (entry === undefined) {
        return null;
      }
      if (entry.kind === "link") {
        return { size: 0, isFile: false, isSymbolicLink: true };
      }
      return { size: entry.kind === "file" ? (entry.size ?? entry.content.length) : 0, isFile: entry.kind === "file", isSymbolicLink: false };
    },
    async realpath(path) {
      const target = resolve(path);
      return entries[target] === undefined ? null : target;
    },
    async readFile(path) {
      if (failReadFor.includes(path)) {
        throw new Error("EACCES");
      }
      const entry = entries[path];
      if (entry?.kind !== "file") {
        throw new Error("ENOENT");
      }
      return entry.content;
    }
  };
};

describe("readBrandColor", () => {
  it("reads the primary color from the root README, any letter case of the name", () => {
    const fs = fakeFs({ "/work/a": { kind: "dir" }, "/work/a/Readme.MD": { kind: "file", content: readme("#f88800") } });
    return readBrandColor("/work/a", fs).then((color) => assert.equal(color, "#F88800"));
  });

  it("returns null for a folder without a README or without a brand section", async () => {
    const fs = fakeFs({
      "/work/empty": { kind: "dir" },
      "/work/plain": { kind: "dir" },
      "/work/plain/README.md": { kind: "file", content: "# 專案\n\n沒有色票。" }
    });
    assert.equal(await readBrandColor("/work/empty", fs), null);
    assert.equal(await readBrandColor("/work/plain", fs), null);
    assert.equal(await readBrandColor("/work/missing", fs), null);
  });

  it("ignores READMEs in sub folders and other file names", async () => {
    const fs = fakeFs({
      "/work/a": { kind: "dir" },
      "/work/a/docs": { kind: "dir" },
      "/work/a/docs/README.md": { kind: "file", content: readme("#111111") },
      "/work/a/README.ja.md": { kind: "file", content: readme("#222222") },
      "/work/a/README.md.bak": { kind: "file", content: readme("#333333") }
    });
    assert.equal(await readBrandColor("/work/a", fs), null);
  });

  it("follows a symlink only when it stays inside the project folder", async () => {
    const fs = fakeFs({
      "/work/inside": { kind: "dir" },
      "/work/inside/docs": { kind: "dir" },
      "/work/inside/docs/BRAND.md": { kind: "file", content: readme("#0066CC") },
      "/work/inside/README.md": { kind: "link", target: "/work/inside/docs/BRAND.md" },
      "/work/outside": { kind: "dir" },
      "/work/outside/README.md": { kind: "link", target: "/secret/README.md" },
      "/secret/README.md": { kind: "file", content: readme("#FF0000") },
      "/work/dangling": { kind: "dir" },
      "/work/dangling/README.md": { kind: "link", target: "/nowhere" }
    });
    assert.equal(await readBrandColor("/work/inside", fs), "#0066CC");
    assert.equal(await readBrandColor("/work/outside", fs), null);
    assert.equal(await readBrandColor("/work/dangling", fs), null);
  });

  it("skips a README over the size cap", async () => {
    const fs = fakeFs({
      "/work/big": { kind: "dir" },
      "/work/big/README.md": { kind: "file", content: readme("#0066CC"), size: BRAND_README_MAX_BYTES + 1 }
    });
    assert.equal(await readBrandColor("/work/big", fs), null);
  });

  it("returns null instead of throwing when the read fails", async () => {
    const fs = fakeFs({ "/work/a": { kind: "dir" }, "/work/a/README.md": { kind: "file", content: readme("#0066CC") } }, ["/work/a/README.md"]);
    assert.equal(await readBrandColor("/work/a", fs), null);
  });
});

describe("readBrandColors", () => {
  const fs = fakeFs({
    "/work/stockPaw": { kind: "dir" },
    "/work/stockPaw/README.md": { kind: "file", content: readme("#F88800") },
    "/work/fictionPurr": { kind: "dir" },
    "/work/fictionPurr/README.md": { kind: "file", content: readme("#0066CC") },
    "/work/plain": { kind: "dir" },
    "/work/plain/README.md": { kind: "file", content: "# 沒有品牌配色" },
    "/work/broken": { kind: "dir" },
    "/work/broken/README.md": { kind: "file", content: readme("#0066CC") }
  }, ["/work/broken/README.md"]);

  it("maps each folder to its own color and omits folders without one", async () => {
    const colors = await readBrandColors(["/work/stockPaw", "/work/fictionPurr", "/work/plain", "/work/missing", "/work/broken"], fs);
    assert.deepEqual(colors, { "/work/stockPaw": "#F88800", "/work/fictionPurr": "#0066CC" });
  });

  it("lists a folder once even when it is written with a trailing slash", async () => {
    const colors = await readBrandColors(["/work/stockPaw", "/work/stockPaw/"], fs);
    assert.deepEqual(colors, { "/work/stockPaw": "#F88800" });
  });

  it("only ever returns well-formed upper-case six digit colors", async () => {
    const colors = await readBrandColors(["/work/stockPaw", "/work/fictionPurr"], fs);
    for (const color of Object.values(colors)) {
      assert.match(color, /^#[0-9A-F]{6}$/);
    }
  });
});

describe("createBrandHandlers", () => {
  it("asks for the folder list on every call so new projects show up without a restart", async () => {
    let folders: string[] = [];
    const fs = fakeFs({ "/work/a": { kind: "dir" }, "/work/a/README.md": { kind: "file", content: readme("#0066CC") } });
    const handlers = createBrandHandlers({ listFolders: () => folders, fs });
    assert.deepEqual(await handlers.colors(), {});
    folders = ["/work/a"];
    assert.deepEqual(await handlers.colors(), { "/work/a": "#0066CC" });
  });
});
