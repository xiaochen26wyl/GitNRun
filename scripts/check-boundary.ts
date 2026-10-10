import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { findViolations, type Layer, type SourceFile, type Violation } from "./boundary";

const ROOT = process.cwd();

const LAYERS: ReadonlyArray<{ layer: Layer; dir: string }> = [
  { layer: "renderer", dir: "src/renderer" },
  { layer: "shared", dir: "src/shared" },
  { layer: "preload", dir: "src/preload" }
];

const SOURCE_EXTENSIONS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

const collect = async (dir: string): Promise<SourceFile[]> => {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: SourceFile[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collect(fullPath)));
    } else if (SOURCE_EXTENSIONS.test(entry.name)) {
      files.push({ path: relative(ROOT, fullPath), source: await readFile(fullPath, "utf8") });
    }
  }
  return files;
};

const main = async (): Promise<void> => {
  const violations: Violation[] = [];
  for (const { layer, dir } of LAYERS) {
    const files = await collect(join(ROOT, dir));
    violations.push(...findViolations(layer, files));
  }

  if (violations.length > 0) {
    console.error("Boundary guard failed:");
    for (const violation of violations) {
      console.error(`- ${violation.path}: "${violation.specifier}" — ${violation.reason}`);
    }
    process.exit(1);
  }

  console.log("Boundary guard passed.");
};

main().catch((error) => {
  console.error(`Boundary guard crashed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
