import { PUSH, type GitNRunApi } from "@shared/ipc";
import { INVOKE_METHODS } from "./methods";

/**
 * 在 Tauri 下提供 window.gitNRun：把每個方法轉成對 Rust 單一指令的呼叫。
 * 傳輸層（invoke、listen）由外面注入，所以這裡可以用假的傳輸層測試，不需要 Tauri。
 */

/** 前端 → Rust 的唯一指令，以及 Rust 轉送核心推播用的事件名稱（Rust 端使用相同字串）。 */
export const IPC_COMMAND = "ipc_invoke";
export const PUSH_EVENT = "gitnrun:push";

export interface ShimTransport {
  invoke(command: string, args: Record<string, unknown>): Promise<unknown>;
  /** 註冊事件監聽；回傳的取消函式要等註冊完成才拿得到，所以是 Promise。 */
  listen(event: string, handler: (payload: unknown) => void): Promise<() => void>;
}

type PushHandler = (payload: never) => void;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * 核心回應包了一層信封：沒有 value 代表 undefined，有 value（含 null）就是結果。
 * 這樣 JSON 的 null 不會和 void 混在一起。
 */
export const unwrapEnvelope = (envelope: unknown): unknown => (isRecord(envelope) && "value" in envelope ? envelope.value : undefined);

/** 拒絕值一律變成帶 name 的 Error 實例，畫面上的 instanceof Error 判斷才會一致。 */
export const toError = (reason: unknown): Error => {
  if (reason instanceof Error) {
    return reason;
  }
  if (isRecord(reason) && typeof reason.message === "string") {
    const error = new Error(reason.message);
    error.name = typeof reason.name === "string" && reason.name !== "" ? reason.name : "Error";
    return error;
  }
  return new Error(typeof reason === "string" ? reason : "unknown error");
};

/** 去掉結尾的 undefined：JSON 會把它變成 null，核心的驗證器會因為參數個數不對而拒絕。 */
export const trimTrailingUndefined = (args: readonly unknown[]): unknown[] => {
  let end = args.length;
  while (end > 0 && args[end - 1] === undefined) {
    end -= 1;
  }
  return args.slice(0, end);
};

export interface ShimApi {
  api: GitNRunApi;
  /** 解除全域監聽（測試用；正式環境整個頁面生命週期都保持）。 */
  dispose(): void;
}

export const createGitNRunApi = (transport: ShimTransport): ShimApi => {
  const handlers = new Map<string, Set<PushHandler>>();

  const dispatch = (payload: unknown): void => {
    if (!isRecord(payload) || typeof payload.channel !== "string") {
      return;
    }
    for (const handler of [...(handlers.get(payload.channel) ?? [])]) {
      try {
        (handler as (value: unknown) => void)(payload.payload);
      } catch (error) {
        console.error("[gitnrun] push handler failed", error);
      }
    }
  };

  // 全域只註冊一次，用「通道 → handler 集合」分發；on* 同步回傳取消函式（相容 StrictMode 雙掛載）。
  let unlisten: (() => void) | null = null;
  let disposed = false;
  void transport.listen(PUSH_EVENT, dispatch).then(
    (stop) => {
      if (disposed) {
        stop();
      } else {
        unlisten = stop;
      }
    },
    (error: unknown) => console.error("[gitnrun] cannot listen for push events", error)
  );

  const subscribe = (channel: string, handler: PushHandler): (() => void) => {
    const set = handlers.get(channel) ?? new Set<PushHandler>();
    set.add(handler);
    handlers.set(channel, set);
    return () => void set.delete(handler);
  };

  const api: Record<string, unknown> = {};
  for (const [method, channel] of Object.entries(INVOKE_METHODS)) {
    api[method] = async (...args: unknown[]): Promise<unknown> => {
      try {
        return unwrapEnvelope(await transport.invoke(IPC_COMMAND, { channel, args: trimTrailingUndefined(args) }));
      } catch (reason) {
        throw toError(reason);
      }
    };
  }
  api.onMonitorChanged = (handler: PushHandler) => subscribe(PUSH.monitorChanged, handler);
  api.onCommandOutput = (handler: PushHandler) => subscribe(PUSH.commandOutput, handler);
  // 只有未掛載的 TerminalView 用到；Tauri 的檔案拖放已關閉，拿不到實際路徑。
  api.pathForFile = () => "";

  return {
    api: api as unknown as GitNRunApi,
    dispose() {
      disposed = true;
      unlisten?.();
      unlisten = null;
      handlers.clear();
    }
  };
};
