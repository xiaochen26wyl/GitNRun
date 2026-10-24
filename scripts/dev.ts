import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { isSupportedNode, MIN_NODE, pickRendererUrl, sidecarNodeOptions, sidecarSocketPath, tauriDevConfig } from "./dev-helpers";

/**
 * 一個指令啟動 Tauri 開發環境：Vite（renderer 熱更新）、sidecar（核心，tsx watch 自動重啟）、tauri dev（Rust 殼）。
 *   改 renderer → Vite HMR；改 src/main、src/shared → sidecar 重啟，視窗不關、Rust 重連後畫面重載一次；
 *   改 src-tauri → tauri dev 重編重啟，sidecar 不死。
 * port 不寫死：沿用 vite.config.ts 的規則（PORT 環境變數，沒給就找空位），實際網址印在 `[dev] renderer <url>`。
 */

const ROOT = process.cwd();
const children: ChildProcess[] = [];
let stopping = false;

const stop = async (code: number, close?: () => Promise<void>): Promise<never> => {
  if (!stopping) {
    stopping = true;
    // 子行程各自一個行程群組，整組一起收（tauri dev 底下的 Rust 殼不會變成孤兒）。
    for (const child of children) {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
    await close?.().catch(() => undefined);
  }
  process.exit(code);
};

const main = async (): Promise<void> => {
  if (!isSupportedNode(process.versions.node)) {
    throw new Error(`需要 Node ${MIN_NODE.join(".")} 以上（目前 ${process.versions.node}），核心使用內建的 node:sqlite`);
  }

  const vite = await createServer({ configFile: join(ROOT, "vite.config.ts") });
  await vite.listen();
  const rendererUrl = pickRendererUrl(vite.resolvedUrls);
  console.log(`[dev] renderer ${rendererUrl}`);
  const closeVite = (): Promise<void> => vite.close();

  const socketPath = sidecarSocketPath(tmpdir(), process.getuid?.() ?? "user");
  const env = {
    ...process.env,
    GITNRUN_SIDECAR_SOCKET: socketPath,
    GITNRUN_SIDECAR_TOKEN: randomBytes(32).toString("hex"),
    PATH: `${join(homedir(), ".cargo", "bin")}:${process.env.PATH ?? ""}`
  };

  // 核心用與打包版相同的 Node 旗標（記憶體上限），只給 sidecar，不影響 Vite 與 tauri。
  const sidecarEnv = { ...env, NODE_OPTIONS: sidecarNodeOptions(process.env.NODE_OPTIONS) };
  const sidecar = spawn(join(ROOT, "node_modules", ".bin", "tsx"), ["watch", "src/main/sidecar/index.ts"], { cwd: ROOT, env: sidecarEnv, stdio: "inherit", detached: true });
  children.push(sidecar);
  console.log(`[dev] sidecar ${socketPath}`);

  const tauri = spawn(join(ROOT, "node_modules", ".bin", "tauri"), ["dev", "--config", tauriDevConfig(rendererUrl)], {
    cwd: ROOT,
    env,
    stdio: "inherit",
    detached: true
  });
  children.push(tauri);
  // 視窗結束（⌘Q）或 tauri 異常結束時，一併收掉 Vite 與 sidecar。
  tauri.on("exit", (code) => void stop(code ?? 0, closeVite));
  sidecar.on("error", (error) => {
    console.error(`[dev] sidecar failed to start: ${error.message}`);
    void stop(1, closeVite);
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void stop(0, closeVite));
  }
};

main().catch((error: unknown) => {
  console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
  void stop(1);
});
