import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { resolveDevPort } from "./scripts/dev-port";

// Tauri 外殼用的標準 Vite 設定（renderer 與 dev port、dev CSP 都在這裡）。
// 打包後的頁面使用嚴格 CSP；dev server 需要 HMR 的 inline script 與 websocket，
// 所以只在 `serve` 期間放寬 meta，並加入 Tauri 的 IPC 來源，不移除，違規仍會在開發時顯示。
const devCspPlugin = (): Plugin => ({
  name: "gitnrun-dev-csp",
  apply: "serve",
  transformIndexHtml: (html) =>
    html.replace(
      /(<meta http-equiv="Content-Security-Policy" content=")([^"]*)(")/,
      (_match, open: string, _policy: string, close: string) =>
        `${open}default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss: ipc: http://ipc.localhost; base-uri 'none'; form-action 'none'${close}`
    )
});

// dev server 的 port：有 PORT 就用（專案啟動頁會傳入），沒給就從 5173 往後找並撇除手動啟動的號碼
// （規則見 scripts/dev-port.ts）。不寫死、不開 strictPort，被搶走時 Vite 會往後找。
const devPortPlugin = (): Plugin => ({
  name: "gitnrun-dev-port",
  apply: "serve",
  config: async () => ({ server: { port: await resolveDevPort() } })
});

export default defineConfig({
  root: ".",
  // 相對路徑：打包後由 Tauri 的自訂協定載入，不是站台根目錄。
  base: "./",
  plugins: [react(), devCspPlugin(), devPortPlugin()],
  server: {
    strictPort: false
  },
  build: {
    outDir: "dist/renderer",
    rollupOptions: {
      input: {
        index: resolve("index.html")
      }
    }
  },
  resolve: {
    alias: {
      "@shared": resolve("src/shared")
    }
  }
});
