import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

/**
 * 把核心（sidecar）打成單一 dist/sidecar/index.cjs，交給內附的 Node 24 執行。
 * node:sqlite 等內建模組保持外部；@shared、@main 別名在這裡解開。
 */

const ROOT = process.cwd();
const OUTFILE = join(ROOT, "dist", "sidecar", "index.cjs");

const main = async (): Promise<void> => {
  mkdirSync(join(ROOT, "dist", "sidecar"), { recursive: true });
  await build({
    entryPoints: [join(ROOT, "src", "main", "sidecar", "index.ts")],
    outfile: OUTFILE,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    alias: { "@shared": join(ROOT, "src", "shared"), "@main": join(ROOT, "src", "main") },
    logLevel: "warning"
  });
  console.log(`[build-sidecar] ${OUTFILE} (${Math.round(statSync(OUTFILE).size / 1024)} KB)`);
};

main().catch((error: unknown) => {
  console.error(`[build-sidecar] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
