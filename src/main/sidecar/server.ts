import { timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { createLineDecoder } from "@main/sidecar/framing";
import {
  CORE_EVENT,
  HOST_REQUEST,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  encodeFrame,
  parseFrame,
  toWireError,
  type Frame,
  type HostInfo
} from "@main/sidecar/protocol";

/**
 * 核心端的連線伺服器：在 unix socket 上等外殼（Rust）連進來。
 * 同一時間只服務一條連線，新的連線通過 hello 後會取代舊的（外殼重編重啟時會重連）。
 * 只做傳輸與關聯：通道驗證交給 invoke，原生能力的請求與回應在這裡對編號。
 */

export interface SidecarServerOptions {
  socketPath: string;
  token: string;
  /** 對應 ipc.invoke：通道與參數的驗證都在 invoke 內（既有的 invokeChannel）。 */
  invoke: (channel: string, args: readonly unknown[]) => Promise<unknown>;
  /** hello 通過、連線已生效並回完 hello 之後呼叫（已去掉 token），此時可以向外殼發原生請求；每次（重）連線都會呼叫。 */
  onConnected: (info: Omit<HostInfo, "token">) => Promise<void> | void;
  /** 外殼送來的單向事件（快捷鍵、選單選取、外部開啟…）。 */
  onEvent: (method: string, payload: unknown) => void;
  onDisconnect?: () => void;
  /** 只記方法名與錯誤名稱，不記任何負載。 */
  log?: (message: string) => void;
  helloTimeoutMs?: number;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface SidecarServer {
  listen(): Promise<void>;
  close(): Promise<void>;
  connected(): boolean;
  /** 推給前端（外殼收到後以事件轉送）；沒連線時直接丟掉。 */
  push(channel: string, payload: unknown): void;
  /** 單向事件給外殼。 */
  event(method: string, payload?: unknown): void;
  /** 向外殼要求原生能力；signal 中止時通知外殼取消，並以 AbortError 拒絕。 */
  request(method: string, params?: unknown, options?: RequestOptions): Promise<unknown>;
}

const HELLO_TIMEOUT_MS = 5000;

export class HostDisconnectedError extends Error {
  constructor(message = "sidecar: host is not connected") {
    super(message);
    this.name = "HostDisconnectedError";
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const tokenMatches = (expected: string, actual: unknown): boolean => {
  if (typeof actual !== "string") {
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
};

const parseHostInfo = (params: unknown): HostInfo | null => {
  if (!isPlainObject(params)) {
    return null;
  }
  const { v, token, appName, appVersion, platform, dataDir, packaged } = params;
  if (
    typeof v !== "number" ||
    typeof token !== "string" ||
    typeof appName !== "string" ||
    typeof appVersion !== "string" ||
    typeof platform !== "string" ||
    typeof dataDir !== "string" ||
    typeof packaged !== "boolean"
  ) {
    return null;
  }
  return { v, token, appName, appVersion, platform, dataDir, packaged };
};

/** ipc.invoke 的負載：{ channel, args }。 */
const parseInvoke = (params: unknown): { channel: string; args: unknown[] } | null => {
  if (!isPlainObject(params) || typeof params.channel !== "string" || !Array.isArray(params.args)) {
    return null;
  }
  return { channel: params.channel, args: params.args };
};

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

interface Connection {
  socket: Socket;
  ready: boolean;
}

export const createSidecarServer = (options: SidecarServerOptions): SidecarServer => {
  const log = options.log ?? (() => undefined);
  const server: Server = createServer();
  let active: Connection | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  const failAllPending = (error: Error): void => {
    for (const entry of [...pending.values()]) {
      entry.cleanup();
      entry.reject(error);
    }
    pending.clear();
  };

  const send = (connection: Connection, frame: Frame): boolean => {
    if (connection.socket.destroyed) {
      return false;
    }
    const line = encodeFrame(frame);
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
      return false;
    }
    connection.socket.write(line);
    return true;
  };

  const respondInvoke = (connection: Connection, id: number, work: () => Promise<unknown>): void => {
    void (async () => {
      let frame: Frame;
      try {
        const value = await work();
        // 以 {} 表示 undefined、{ value } 表示有值（含 null），讓外殼之後不必猜 JSON 的 null。
        frame = { k: "res", id, ok: true, v: value === undefined ? {} : { value } };
      } catch (error) {
        frame = { k: "res", id, ok: false, e: toWireError(error) };
      }
      if (!send(connection, frame)) {
        // 回應太大送不出去，改回錯誤，不讓外殼因超長訊息斷線。
        send(connection, { k: "res", id, ok: false, e: { name: "Error", message: "response too large" } });
      }
    })();
  };

  const handleHello = (connection: Connection, id: number, params: unknown): void => {
    const info = parseHostInfo(params);
    if (info === null || info.v !== PROTOCOL_VERSION || !tokenMatches(options.token, info.token)) {
      log("hello rejected");
      send(connection, { k: "res", id, ok: false, e: { name: "Error", message: "hello rejected" } });
      connection.socket.end();
      return;
    }
    const { token: _token, ...rest } = info;
    // 新連線取代舊連線；舊連線上還在等的原生請求一併結束。
    const previous = active;
    active = connection;
    connection.ready = true;
    if (previous && previous !== connection) {
      failAllPending(new HostDisconnectedError("sidecar: connection replaced"));
      previous.socket.destroy();
    }
    send(connection, { k: "res", id, ok: true });
    void (async () => {
      try {
        await options.onConnected(rest);
      } catch (error) {
        log(`onConnected failed: ${toWireError(error).name}`);
      }
    })();
  };

  const handleFrame = (connection: Connection, frame: Frame): void => {
    if (!connection.ready) {
      // 通過 hello 之前只接受 hello。
      if (frame.k === "req" && frame.m === HOST_REQUEST.hello) {
        handleHello(connection, frame.id, frame.p);
      } else {
        connection.socket.destroy();
      }
      return;
    }
    if (active !== connection) {
      return;
    }

    if (frame.k === "res") {
      const entry = pending.get(frame.id);
      if (!entry) {
        return;
      }
      pending.delete(frame.id);
      entry.cleanup();
      if (frame.ok) {
        entry.resolve(frame.v);
      } else {
        const error = new Error(frame.e.message);
        error.name = frame.e.name;
        entry.reject(error);
      }
      return;
    }
    if (frame.k === "evt") {
      options.onEvent(frame.m, frame.p);
      return;
    }
    if (frame.m === HOST_REQUEST.ipcInvoke) {
      const call = parseInvoke(frame.p);
      if (call === null) {
        send(connection, { k: "res", id: frame.id, ok: false, e: { name: "Error", message: "ipc: malformed invoke" } });
        return;
      }
      respondInvoke(connection, frame.id, () => options.invoke(call.channel, call.args));
      return;
    }
    send(connection, { k: "res", id: frame.id, ok: false, e: { name: "Error", message: "unknown method" } });
  };

  server.on("connection", (socket) => {
    const connection: Connection = { socket, ready: false };
    const decoder = createLineDecoder();
    const helloTimer = setTimeout(() => {
      if (!connection.ready) {
        socket.destroy();
      }
    }, options.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
    helloTimer.unref();

    socket.on("data", (chunk) => {
      try {
        for (const line of decoder.push(chunk)) {
          const frame = parseFrame(line);
          if (frame === null) {
            socket.destroy();
            return;
          }
          handleFrame(connection, frame);
        }
      } catch {
        // 訊息超長或形狀錯誤：直接斷線。
        socket.destroy();
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      clearTimeout(helloTimer);
      if (active === connection) {
        active = null;
        failAllPending(new HostDisconnectedError());
        options.onDisconnect?.();
      }
    });
  });

  const prepareSocketPath = (): void => {
    const dir = dirname(options.socketPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // 目錄必須只有自己能進，否則其他本機使用者可以搶連線。
    if ((statSync(dir).mode & 0o077) !== 0) {
      chmodSync(dir, 0o700);
    }
    if (existsSync(options.socketPath)) {
      unlinkSync(options.socketPath);
    }
  };

  return {
    listen: () =>
      new Promise<void>((resolve, reject) => {
        try {
          prepareSocketPath();
        } catch (error) {
          reject(error);
          return;
        }
        server.once("error", reject);
        server.listen(options.socketPath, () => {
          server.off("error", reject);
          chmodSync(options.socketPath, 0o600);
          resolve();
        });
      }),

    close: () =>
      new Promise<void>((resolve) => {
        active?.socket.destroy();
        active = null;
        failAllPending(new HostDisconnectedError("sidecar: closing"));
        server.close(() => {
          try {
            unlinkSync(options.socketPath);
          } catch {
            // 已經不在了。
          }
          resolve();
        });
      }),

    connected: () => active !== null,

    push(channel, payload) {
      if (active) {
        send(active, { k: "evt", m: CORE_EVENT.push, p: { channel, payload } });
      }
    },

    event(method, payload) {
      if (active) {
        send(active, { k: "evt", m: method, ...(payload === undefined ? {} : { p: payload }) });
      }
    },

    request(method, params, requestOptions) {
      const connection = active;
      if (!connection) {
        return Promise.reject(new HostDisconnectedError());
      }
      const signal = requestOptions?.signal;
      if (signal?.aborted) {
        return Promise.reject(new DOMException("aborted", "AbortError"));
      }
      return new Promise<unknown>((resolve, reject) => {
        const id = nextId;
        nextId += 1;
        const onAbort = (): void => {
          if (!pending.delete(id)) {
            return;
          }
          send(connection, { k: "evt", m: CORE_EVENT.cancel, p: { id } });
          reject(new DOMException("aborted", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        pending.set(id, { resolve, reject, cleanup: () => signal?.removeEventListener("abort", onAbort) });
        const sent = send(connection, { k: "req", id, m: method, ...(params === undefined ? {} : { p: params }) });
        if (!sent) {
          pending.delete(id);
          signal?.removeEventListener("abort", onAbort);
          reject(new Error("sidecar: request too large or connection closed"));
        }
      });
    }
  };
};
