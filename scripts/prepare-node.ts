import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveUrl,
  binaryFileName,
  isAcceptableLocalNode,
  nodePathInArchive,
  targetFor,
  tripleFor,
  verifyArchive,
  type RuntimeManifest
} from "./node-runtime";

/**
 * 準備 Tauri 的 externalBin：src-tauri/binaries/gitnrun-node-<三元組>。
 * 本機架構直接複製正在執行的 Node（必須是 Node 24）；其他架構才需要下載官方二進位，
 * 下載來源、大小與 SHA-256 釘在 node-runtime.json，校驗不符就中止。
 *
 *   tsx scripts/prepare-node.ts                      本機架構
 *   tsx scripts/prepare-node.ts x86_64-apple-darwin  指定架構（非本機會下載，需明確指定）
 */

const ROOT = process.cwd();
const OUT_DIR = join(ROOT, "src-tauri", "binaries");

const download = async (url: string): Promise<Uint8Array> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下載失敗：${response.status} ${url}`);
  return new Uint8Array(await response.arrayBuffer());
};

const main = async (): Promise<void> => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "scripts", "node-runtime.json"), "utf8")) as RuntimeManifest;
  const hostTriple = tripleFor(process.arch);
  const triple = process.argv[2] ?? hostTriple;
  if (!triple || !hostTriple) throw new Error(`不支援的架構：${process.arch}`);
  const target = targetFor(manifest, triple);
  const destination = join(OUT_DIR, binaryFileName(triple));
  mkdirSync(OUT_DIR, { recursive: true });

  if (triple === hostTriple) {
    if (!isAcceptableLocalNode(process.versions.node)) {
      throw new Error(`本機 Node ${process.versions.node} 不是 ${manifest.version.split(".")[0]}.x，請用 Node ${manifest.version.split(".")[0]} 執行`);
    }
    copyFileSync(process.execPath, destination);
    chmodSync(destination, 0o755);
    console.log(`[prepare-node] copied local Node ${process.versions.node} → ${destination}`);
    return;
  }

  const url = archiveUrl(manifest, target);
  console.log(`[prepare-node] downloading ${url}`);
  const data = await download(url);
  verifyArchive(data, target);
  console.log("[prepare-node] size and SHA-256 verified");

  // 下載的檔案不可信：放在全新的空資料夾解開，只取出 node 一個檔案。
  const work = mkdtempSync(join(tmpdir(), "gnr-node-"));
  try {
    const archivePath = join(work, target.archive);
    writeFileSync(archivePath, data);
    execFileSync("/usr/bin/tar", ["-xzf", archivePath, "-C", work, nodePathInArchive(target.archive)]);
    const extracted = join(work, nodePathInArchive(target.archive));
    if (!existsSync(extracted)) throw new Error("壓縮檔裡找不到 bin/node");
    copyFileSync(extracted, destination);
    chmodSync(destination, 0o755);
    console.log(`[prepare-node] downloaded Node ${manifest.version} → ${destination}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};

main().catch((error: unknown) => {
  console.error(`[prepare-node] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
