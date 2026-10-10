import {
  MAX_LIVE_LINES_PER_RUN,
  type CommandOutputEvent,
  type CommandRunStatus
} from "@shared/command-output";

/**
 * 指令的即時輸出匯流。
 *
 * - 以「行」為單位：脫敏是對整行做，所以密鑰就算被切在兩個資料區塊之間也不會漏出去。
 * - 批次送出（預設 100ms 一批），不會用大量小訊息淹沒 IPC。
 * - 每次執行最多推送固定行數，其餘省略（完整輸出另存在日誌，有上限）。
 */

export interface OutputHubDeps {
  emit: (events: CommandOutputEvent[]) => void;
  now: () => number;
  newId: () => string;
  schedule?: (fn: () => void, ms: number) => void;
  flushMs?: number;
}

export interface RunHandle {
  readonly runId: string;
  write(stream: "stdout" | "stderr", chunk: string): void;
  /** 程式自己的說明（例如「第 1 次失敗，5 秒後重試」）。 */
  note(text: string): void;
  end(status: CommandRunStatus): void;
}

export interface OutputHub {
  begin(label: string, redact: (text: string) => string): RunHandle;
}

const MAX_PARTIAL_LINE = 8 * 1024;
const OMITTED_NOTICE = "…輸出太多，其餘省略（完整內容請看日誌）";

export const createOutputHub = (deps: OutputHubDeps): OutputHub => {
  const schedule = deps.schedule ?? ((fn, ms) => void setTimeout(fn, ms).unref());
  const flushMs = deps.flushMs ?? 100;
  let queue: CommandOutputEvent[] = [];
  let pending = false;

  const flush = (): void => {
    pending = false;
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    deps.emit(batch);
  };

  const push = (event: CommandOutputEvent): void => {
    queue.push(event);
    if (!pending) {
      pending = true;
      schedule(flush, flushMs);
    }
  };

  return {
    begin(label, redact) {
      const runId = deps.newId();
      const partial = { stdout: "", stderr: "" };
      let lines = 0;
      let omitted = false;
      let ended = false;

      const emitLine = (stream: "stdout" | "stderr" | "system", raw: string): void => {
        if (lines >= MAX_LIVE_LINES_PER_RUN) {
          if (!omitted) {
            omitted = true;
            push({ kind: "line", runId, stream: "system", text: OMITTED_NOTICE, at: deps.now() });
          }
          return;
        }
        lines += 1;
        push({ kind: "line", runId, stream, text: redact(raw), at: deps.now() });
      };

      push({ kind: "start", runId, label, at: deps.now() });

      return {
        runId,

        write(stream, chunk) {
          if (ended) return;
          let buffer = partial[stream] + chunk.replaceAll("\r\n", "\n");
          let newline = buffer.indexOf("\n");
          while (newline !== -1) {
            emitLine(stream, buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
          }
          // 一直沒有換行的超長輸出：不能無限累積，直接當一行送出。
          if (buffer.length > MAX_PARTIAL_LINE) {
            emitLine(stream, buffer);
            buffer = "";
          }
          partial[stream] = buffer;
        },

        note(text) {
          if (!ended) emitLine("system", text);
        },

        end(status) {
          if (ended) return;
          for (const stream of ["stdout", "stderr"] as const) {
            if (partial[stream].length > 0) {
              emitLine(stream, partial[stream]);
              partial[stream] = "";
            }
          }
          ended = true;
          push({ kind: "end", runId, status, at: deps.now() });
        }
      };
    }
  };
};
