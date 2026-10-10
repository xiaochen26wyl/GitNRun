import { spawn } from "node:child_process";

/**
 * 執行外部程式的底層：逾時就終止「整個行程群組」（shell 底下的子行程也一併收掉）、
 * 輸出有上限、即時串流輸出。呼叫端負責脫敏（這裡只負責搬運）。
 */

export type OutputStream = "stdout" | "stderr";

export interface RunProcessOptions {
  file: string;
  args: readonly string[];
  cwd: string;
  /** 子行程的完整環境；不會繼承本程式的 process.env。 */
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  /** SIGTERM 之後多久還沒結束就改送 SIGKILL。 */
  killGraceMs?: number;
  /** stdout＋stderr 合計最多保留多少位元組；超過的部分丟棄並標記 truncated。 */
  maxOutputBytes?: number;
  onOutput?: (chunk: { stream: OutputStream; text: string }) => void;
}

export interface ProcessResult {
  /** 正常結束的結束碼；被訊號終止時為 null。 */
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  /** 無法啟動（找不到程式、工作目錄不存在、沒有權限）時的錯誤代碼，如 ENOENT。 */
  spawnError?: string;
}

export const DEFAULT_KILL_GRACE_MS = 5_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

export const runProcess = (options: RunProcessOptions): Promise<ProcessResult> =>
  new Promise((resolve) => {
    const started = Date.now();
    const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const grace = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

    let stdout = "";
    let stderr = "";
    let kept = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;

    const finish = (result: Omit<ProcessResult, "durationMs" | "stdout" | "stderr" | "truncated" | "timedOut">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ ...result, timedOut, durationMs: Date.now() - started, stdout, stderr, truncated });
    };

    const child = spawn(options.file, [...options.args], {
      cwd: options.cwd,
      env: { ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      // 自成一個行程群組，逾時才能連同它底下的子行程一起終止。
      detached: true,
      windowsHide: true
    });

    const killGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) {
          process.kill(-child.pid, signal);
          return;
        }
      } catch {
        // 群組已不存在，退回只送給主行程。
      }
      child.kill(signal);
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), grace);
    }, options.timeoutMs);

    const collect = (stream: OutputStream) => (data: string) => {
      options.onOutput?.({ stream, text: data });
      const room = maxBytes - kept;
      if (room <= 0) {
        truncated = true;
        return;
      }
      const piece = Buffer.byteLength(data) <= room ? data : Buffer.from(data).subarray(0, room).toString("utf8");
      truncated ||= piece.length < data.length;
      kept += Buffer.byteLength(piece);
      if (stream === "stdout") stdout += piece;
      else stderr += piece;
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));

    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({ code: null, signal: null, spawnError: error.code ?? "SPAWN_FAILED" });
    });
    child.on("close", (code, signal) => {
      finish({ code, signal });
    });
  });
