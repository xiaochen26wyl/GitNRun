import { join } from "node:path";
import { SIDECAR_NODE_FLAGS } from "./node-runtime";

/** `node:sqlite` 需要的最低 Node 版本。 */
export const MIN_NODE: readonly [number, number] = [22, 5];

/** 解析 `process.versions.node` 這類字串；格式不對回傳 null。 */
export const parseNodeVersion = (version: string): [number, number, number] | null => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};

export const isSupportedNode = (version: string, min: readonly [number, number] = MIN_NODE): boolean => {
  const parsed = parseNodeVersion(version);
  if (parsed === null) return false;
  const [major, minor] = parsed;
  return major > min[0] || (major === min[0] && minor >= min[1]);
};

/** sidecar 的 unix socket：放在暫存目錄底下自己專屬的資料夾（sidecar 會把資料夾建成 0700）。 */
export const sidecarSocketPath = (tmpDir: string, uid: number | string): string => join(tmpDir, `gitnrun-${uid}`, "core.sock");

/** 讓 `tauri dev` 使用實際的 Vite 網址，且不再自己啟動前端（Vite 已由 dev 腳本啟動）。 */
export const tauriDevConfig = (devUrl: string): string =>
  JSON.stringify({ build: { devUrl, beforeDevCommand: null } });

/** 從 Vite 回報的本機網址挑一個；沒有就報錯，不猜 port。 */
export const pickRendererUrl = (resolved: { local?: readonly string[] } | null | undefined): string => {
  const url = resolved?.local?.[0];
  if (!url) throw new Error("Vite 沒有回報本機網址");
  return url;
};

/** dev 時 sidecar 由 tsx 啟動，旗標經 NODE_OPTIONS 帶入；保留使用者原本已有的 NODE_OPTIONS。 */
export const sidecarNodeOptions = (existing: string | undefined): string => [existing?.trim(), ...SIDECAR_NODE_FLAGS].filter((part) => part).join(" ");
