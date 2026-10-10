import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";

// 打包後的頁面使用嚴格 CSP（禁止任何對外連線，所有網路只在主程序發生）。
// dev server 需要 HMR 的 inline script 與 websocket，所以只在 `serve` 期間放寬 meta，
// 不移除，違規仍會在開發時顯示。
const devCspPlugin = (): Plugin => ({
  name: "gitnrun-dev-csp",
  apply: "serve",
  transformIndexHtml: (html) =>
    html.replace(
      /(<meta http-equiv="Content-Security-Policy" content=")([^"]*)(")/,
      (_match, open: string, _policy: string, close: string) =>
        `${open}default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'${close}`
    )
});

export default defineConfig({
  main: {
    // 主程序的依賴一律打包，避免打包後的執行期解析問題。
    plugins: [],
    build: {
      outDir: "dist/main",
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts")
        }
      }
    },
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
        "@main": resolve("src/main")
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "dist/preload",
      rollupOptions: {
        input: {
          index: resolve("src/preload/index.ts")
        }
      }
    },
    resolve: {
      alias: {
        "@shared": resolve("src/shared")
      }
    }
  },
  renderer: {
    root: ".",
    plugins: [react(), devCspPlugin()],
    // port 由啟動端決定（專案啟動頁會以 PORT 傳入）；沒給就用 Vite 預設，被占用時自動往後找。
    server: {
      port: Number.isInteger(Number(process.env.PORT)) && Number(process.env.PORT) > 0 ? Number(process.env.PORT) : undefined,
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
  }
});
