import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectFramework, type FrameworkFs } from "@main/run/framework";

const fsOf = (files: Record<string, string>): FrameworkFs => ({
  readText: async (path) => files[path] ?? null,
  listDirs: async (path) => {
    const prefix = `${path}/`;
    return [...new Set(Object.keys(files).filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length).split("/")[0] ?? ""))].filter((name) => name !== "" && !name.includes("."));
  }
});

const pkg = (value: Record<string, unknown>): string => JSON.stringify(value);
const spec = (command: string[], cwd = ".") => ({ command, cwd });

describe("detectFramework", () => {
  it("recognizes Django from manage.py", async () => {
    assert.equal(await detectFramework("/work/app", spec([".venv/bin/python", "manage.py", "runserver", "127.0.0.1:{port}"], "services/api"), fsOf({})), "Django");
  });

  it("recognizes FastAPI from uvicorn plus the pyproject dependency", async () => {
    const fs = fsOf({ "/work/app/pyproject.toml": 'dependencies = ["FastAPI>=0.110", "uvicorn"]' });
    assert.equal(await detectFramework("/work/app", spec([".venv/bin/python", "-m", "uvicorn", "app.main:app"]), fs), "FastAPI");
  });

  it("reads the script body of a package script", async () => {
    const fs = fsOf({ "/work/app/packages/web/package.json": pkg({ scripts: { dev: "NODE_ENV=development next dev" }, dependencies: { react: "1" } }) });
    assert.equal(await detectFramework("/work/app", spec(["pnpm", "dev"], "packages/web"), fs), "Next.js");
  });

  it("prefers the tool the script actually runs over installed packages", async () => {
    const fs = fsOf({ "/work/app/package.json": pkg({ scripts: { start: "tauri dev" }, devDependencies: { electron: "1", "@tauri-apps/cli": "2" } }) });
    assert.equal(await detectFramework("/work/app", spec(["pnpm", "start"]), fs), "Tauri");
  });

  it("falls back to dependencies when the script gives no hint", async () => {
    const fs = fsOf({ "/work/app/package.json": pkg({ scripts: { dev: "node server.js" }, dependencies: { hono: "4" } }) });
    assert.equal(await detectFramework("/work/app", spec(["npm", "run", "dev"]), fs), "Hono");
  });

  it("recognizes Flutter from the command", async () => {
    assert.equal(await detectFramework("/work/app", spec(["flutter", "run", "-d", "iPhone"]), fsOf({})), "Flutter");
  });

  it("resolves --filter to the workspace package", async () => {
    const fs = fsOf({
      "/work/app/package.json": pkg({ name: "root" }),
      "/work/app/apps/api/package.json": pkg({ name: "api", scripts: { dev: "tsx watch src/index.ts" }, dependencies: { fastify: "5" } }),
      "/work/app/apps/web/package.json": pkg({ name: "web", dependencies: { react: "19" } })
    });
    assert.equal(await detectFramework("/work/app", spec(["pnpm", "--filter=api", "dev"]), fs), "Fastify");
    assert.equal(await detectFramework("/work/app", spec(["pnpm", "--filter", "web", "dev"]), fs), "React");
  });

  it("returns null when nothing can be recognized", async () => {
    assert.equal(await detectFramework("/work/app", spec(["uv", "run", "python", "-m", "tool"]), fsOf({})), null);
    assert.equal(await detectFramework("/work/app", spec(["pnpm", "--filter=missing", "dev"]), fsOf({ "/work/app/package.json": "{broken" })), null);
  });
});
