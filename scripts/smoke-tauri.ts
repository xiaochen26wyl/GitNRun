import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLineDecoder } from "../src/main/sidecar/framing";
import { PROTOCOL_VERSION, encodeFrame, parseFrame, type Frame } from "../src/main/sidecar/protocol";
import { SIDECAR_NODE_FLAGS, binaryFileName, tripleFor } from "./node-runtime";

/**
 * 打包產物的冒煙測試：檢查 renderer 與核心的輸出存在，再用「內附的 Node」在臨時資料夾啟動打包後的核心，
 * 由假外殼走完 hello → 取主金鑰 → app:info → 結束，並確認核心自己收尾（結束碼 0、鎖檔與 socket 都清掉）。
 * 打包壞掉（缺檔、Node 被系統終止、核心起不來、收尾不乾淨）都會在這裡失敗。
 */

const ROOT = process.cwd();
const TIMEOUT_MS = 30_000;

const fail = (message: string): never => {
  console.error(`Smoke (tauri) failed: ${message}`);
  process.exit(1);
};

const requireFile = (relative: string): string => {
  const path = join(ROOT, relative);
  if (!existsSync(path)) fail(`missing build artifact: ${relative}`);
  return path;
};

const main = async (): Promise<void> => {
  requireFile("dist/renderer/index.html");
  const script = requireFile("dist/sidecar/index.cjs");
  const triple = tripleFor(process.arch);
  if (!triple) return fail(`unsupported architecture ${process.arch}`);
  const bundledNode = requireFile(join("src-tauri", "binaries", binaryFileName(triple)));
  const entitlements = requireFile(join("src-tauri", "entitlements.plist"));

  const work = mkdtempSync(join(tmpdir(), "gnr-smoke-"));
  // Tauri 打包時會就地重新簽署這個檔案，之後單獨執行會被系統終止；所以複製一份，
  // 用與打包相同的方式（hardened runtime ＋ 專案的 entitlements）簽署再跑，同時驗證 entitlements 夠用。
  const node = join(work, "gitnrun-node");
  copyFileSync(bundledNode, node);
  execFileSync("/usr/bin/codesign", ["--force", "--options", "runtime", "--entitlements", entitlements, "-s", "-", node], { stdio: "ignore" });
  const dataDir = join(work, "data-root");
  const socketPath = join(work, "run", "core.sock");
  const token = randomBytes(24).toString("hex");

  const child = spawn(node, [...SIDECAR_NODE_FLAGS, script], {
    env: { PATH: process.env.PATH ?? "", GITNRUN_SIDECAR_SOCKET: socketPath, GITNRUN_SIDECAR_TOKEN: token },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    fail(`timed out after ${TIMEOUT_MS / 1000}s\n${stderr}`);
  }, TIMEOUT_MS);

  try {
    // 等核心開始監聽。
    for (let i = 0; i < 100 && !existsSync(socketPath); i += 1) await new Promise((r) => setTimeout(r, 100));
    if (!existsSync(socketPath)) fail(`the bundled core never started listening\n${stderr}`);

    const socket = connect(socketPath);
    const decoder = createLineDecoder();
    const frames: Frame[] = [];
    const waiters: Array<() => void> = [];
    socket.on("data", (chunk) => {
      for (const line of decoder.push(chunk)) {
        const frame = parseFrame(line);
        if (!frame) continue;
        frames.push(frame);
        // 核心啟動時會要求原生能力：金鑰給一把隨機的、其餘一律回「沒有結果」。
        if (frame.k === "req" && frame.m.startsWith("native.")) {
          const v = frame.m === "native.keychain.masterKey" ? randomBytes(32).toString("base64") : frame.m === "native.shortcut.register" ? true : undefined;
          socket.write(encodeFrame({ k: "res", id: frame.id, ok: true, ...(v === undefined ? {} : { v }) }));
        }
      }
      for (const wake of waiters.splice(0)) wake();
    });
    const waitFor = (predicate: (frame: Frame) => boolean, what: string): Promise<Frame> =>
      new Promise((resolve) => {
        const giveUp = setTimeout(() => fail(`no ${what}\n${stderr}`), TIMEOUT_MS - 2000);
        const check = (): void => {
          const found = frames.find(predicate);
          if (found) {
            clearTimeout(giveUp);
            resolve(found);
          } else {
            waiters.push(check);
          }
        };
        check();
      });

    socket.write(encodeFrame({ k: "req", id: 1, m: "hello", p: { v: PROTOCOL_VERSION, token, appName: "GitNRun", appVersion: "smoke", platform: "darwin", dataDir, packaged: true } }));
    const hello = await waitFor((f) => f.k === "res" && f.id === 1, "hello response");
    if (hello.k !== "res" || !hello.ok) return fail("hello was rejected");
    await waitFor((f) => f.k === "evt" && f.m === "ready", "ready event");

    socket.write(encodeFrame({ k: "req", id: 2, m: "ipc.invoke", p: { channel: "app:info", args: [] } }));
    const info = await waitFor((f) => f.k === "res" && f.id === 2, "app:info response");
    const value = info.k === "res" && info.ok ? (info.v as { value?: { name?: string; version?: string } } | undefined)?.value : undefined;
    if (value?.name !== "GitNRun" || value.version !== "smoke") return fail(`unexpected app:info: ${JSON.stringify(info)}`);

    // 乾淨結束：核心自己關資料庫、放掉鎖、刪掉 socket，結束碼 0。
    socket.write(encodeFrame({ k: "evt", m: "app.quit" }));
    const code = await exited;
    if (code !== 0) return fail(`the core exited with code ${code} instead of 0\n${stderr}`);
    if (existsSync(socketPath)) fail("the socket file was left behind");
    if (existsSync(join(dataDir, "sidecar.lock"))) fail("the data-directory lock was left behind");
    console.log("Smoke (tauri) passed: bundled node ran the bundled core; hello, app:info and a clean shutdown all worked.");
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    rmSync(work, { recursive: true, force: true });
  }
};

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
