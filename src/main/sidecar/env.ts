/**
 * sidecar 啟動時由外殼經環境變數交付的連線資訊。
 * token 讀完立刻從環境變數刪除：核心會替啟動的服務產生子行程，子行程預設繼承環境變數，
 * 不刪的話任何被啟動的程式都拿得到連回外殼的憑證（run.ts 的 FORBIDDEN_ENV 另外擋住手動設定）。
 */

export const ENV_SOCKET = "GITNRUN_SIDECAR_SOCKET";
export const ENV_TOKEN = "GITNRUN_SIDECAR_TOKEN";

export interface SidecarEnv {
  socketPath: string;
  token: string;
}

export const takeSidecarEnv = (env: NodeJS.ProcessEnv): SidecarEnv => {
  const socketPath = env[ENV_SOCKET];
  const token = env[ENV_TOKEN];
  delete env[ENV_TOKEN];
  delete env[ENV_SOCKET];
  if (!socketPath || !socketPath.startsWith("/")) {
    throw new Error(`sidecar: ${ENV_SOCKET} must be an absolute path`);
  }
  if (!token || token.length < 16) {
    throw new Error(`sidecar: ${ENV_TOKEN} is missing or too short`);
  }
  return { socketPath, token };
};
