import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startCore, type Core } from "@main/bootstrap";
import { invokeChannel } from "@main/ipc";
import { createExternalOpenGate } from "@main/launcher/external";
import { setNative } from "@main/native/bridge";
import { createRemoteNativeBridge, type RemoteBridge } from "@main/native/remote-bridge";
import { createAesGcmCipher, decodeMasterKey } from "@main/vault/aes-gcm-cipher";
import { takeSidecarEnv } from "@main/sidecar/env";
import { acquireLock, LockHeldError, type Lock } from "@main/sidecar/lock";
import { CORE_EVENT, EXIT_NO_RESTART, HOST_EVENT, NATIVE } from "@main/sidecar/protocol";
import { createSidecarServer } from "@main/sidecar/server";

/**
 * Tauri 外殼底下的核心行程入口：不碰視窗，只等外殼連進來，
 * 第一次 hello 通過後才啟動核心（資料庫、保險庫、監視器…），之後的重連只換連線、不重啟核心。
 */

const log = (message: string): void => console.error(`[sidecar] ${message}`);

const { socketPath, token } = takeSidecarEnv(process.env);

const externalGate = createExternalOpenGate();
let core: Core | null = null;
let lock: Lock | null = null;
let remote: RemoteBridge | null = null;
let starting = false;

const shutdown = (code: number): void => {
  try {
    core?.releaseShortcuts();
    core?.stop();
  } finally {
    lock?.release();
    void server.close().finally(() => process.exit(code));
  }
};

const server = createSidecarServer({
  socketPath,
  token,
  log,
  invoke: (channel, args) => {
    if (core === null) {
      return Promise.reject(new Error("core is not ready"));
    }
    return invokeChannel(channel, args);
  },
  onEvent: (method, payload) => {
    if (method === HOST_EVENT.quit) {
      shutdown(0);
      return;
    }
    if (method === HOST_EVENT.externalOpen) {
      const request = payload as { kind?: unknown; value?: unknown } | null;
      if ((request?.kind === "url" || request?.kind === "file") && typeof request.value === "string") {
        externalGate.push({ kind: request.kind, value: request.value });
      }
      return;
    }
    remote?.handleEvent(method, payload);
  },
  onConnected: async (info) => {
    if (core !== null) {
      // 外殼重連（例如 Rust 重編重啟）：核心不動，只補回外殼端的狀態。
      await remote?.restoreAfterReconnect();
      server.event(CORE_EVENT.ready);
      return;
    }
    if (starting) {
      return;
    }
    starting = true;
    try {
      // 全新安裝時資料夾還不存在；先建起來（只有本人可讀寫），鎖檔與資料庫都放在裡面。
      mkdirSync(info.dataDir, { recursive: true, mode: 0o700 });
      lock = acquireLock(join(info.dataDir, "sidecar.lock"));
    } catch (error) {
      if (error instanceof LockHeldError) {
        log("another sidecar owns the data directory");
        process.exit(EXIT_NO_RESTART);
      }
      throw error;
    }
    remote = createRemoteNativeBridge({ server, info, exit: (code) => shutdown(code) });
    setNative(remote.bridge);

    // 主金鑰只活在 cipher 的閉包裡；拿不到就讓保險庫保持不可用，絕不退回明文。
    const masterKey = await server.request(NATIVE.masterKey).then(decodeMasterKey, () => null);
    try {
      core = startCore({ externalGate, cipher: createAesGcmCipher(masterKey) });
    } catch (error) {
      log(`core failed to start: ${error instanceof Error ? error.name : "error"}`);
      lock?.release();
      process.exit(EXIT_NO_RESTART);
    }
    server.event(CORE_EVENT.ready);
  }
});

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

void server.listen().then(
  () => log("listening"),
  (error: unknown) => {
    log(`cannot listen: ${error instanceof Error ? error.name : "error"}`);
    process.exit(EXIT_NO_RESTART);
  }
);
