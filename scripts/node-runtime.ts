import { createHash } from "node:crypto";

/**
 * 內附 Node 的選擇與校驗（純函式，prepare-node.ts 與測試共用）。
 * 下載來源、檔名、SHA-256 與大小都釘在 node-runtime.json；校驗不符一律中止，不使用未校驗的二進位。
 */

export interface RuntimeTarget {
  archive: string;
  sha256: string;
  bytes: number;
}

export interface RuntimeManifest {
  version: string;
  baseUrl: string;
  targets: Record<string, RuntimeTarget>;
}

export const MAJOR_REQUIRED = 24;

/**
 * 核心（sidecar）的 Node 旗標。實測：核心存活的 JS 資料只有約 7 MB，但 V8 預設的新生代（semi-space 16 MB）
 * 會把記憶體撐到約 88 MB；限制成 1 MB 後同樣負載只剩約 38 MB（效能與錯誤數無差異）。
 * old-space 上限 128 MB 只是防止失控時吃光記憶體的保險，正常使用遠遠不會碰到。
 * 打包版的啟動（src-tauri/src/launch.rs）必須使用相同的旗標，tests/sidecar-node-flags.test.ts 會檢查。
 */
export const SIDECAR_NODE_FLAGS: readonly string[] = ["--max-semi-space-size=1", "--max-old-space-size=128"];

/** Node 的 process.arch → Rust 的目標三元組（只支援 macOS）。 */
export const tripleFor = (arch: string): string | null => {
  if (arch === "arm64") return "aarch64-apple-darwin";
  if (arch === "x64") return "x86_64-apple-darwin";
  return null;
};

/** Tauri 的 externalBin 規定的檔名：`<名稱>-<三元組>`。 */
export const binaryFileName = (triple: string): string => `gitnrun-node-${triple}`;

export const sha256Of = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrityError";
  }
}

/** 大小與 SHA-256 都要相符才放行；不符丟出 IntegrityError。 */
export const verifyArchive = (data: Uint8Array, target: RuntimeTarget): void => {
  if (data.byteLength !== target.bytes) {
    throw new IntegrityError(`下載大小不符：預期 ${target.bytes}，實際 ${data.byteLength}`);
  }
  const actual = sha256Of(data);
  if (actual !== target.sha256.toLowerCase()) {
    throw new IntegrityError("下載內容的 SHA-256 與釘住的值不符，已中止");
  }
};

export const targetFor = (manifest: RuntimeManifest, triple: string): RuntimeTarget => {
  const target = manifest.targets[triple];
  if (!target) {
    throw new Error(`node-runtime.json 沒有 ${triple} 的設定`);
  }
  return target;
};

export const archiveUrl = (manifest: RuntimeManifest, target: RuntimeTarget): string => new URL(target.archive, manifest.baseUrl).toString();

/** 本機直接複製的 Node 必須是同一個大版本，否則核心行為（node:sqlite 等）可能與下載版不同。 */
export const isAcceptableLocalNode = (version: string): boolean => version.split(".")[0] === String(MAJOR_REQUIRED);

/** 壓縮檔內要取出的路徑：`node-v<版本>-darwin-<arch>/bin/node`。 */
export const nodePathInArchive = (archive: string): string => `${archive.replace(/\.tar\.gz$/, "")}/bin/node`;
