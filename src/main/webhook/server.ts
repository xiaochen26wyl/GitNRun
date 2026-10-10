import { createServer, type IncomingMessage, type Server } from "node:http";
import { MAX_WEBHOOK_BODY_BYTES, WEBHOOK_HOST } from "@shared/webhook";
import type { WebhookRequest, WebhookResponse } from "@main/webhook/handler";

/**
 * Webhook 的本機 HTTP 接收端：只綁 127.0.0.1（主機位址寫死，設定改不了），
 * 公網的 TLS 由使用者自備的隧道終止，所以這一段不另做自簽憑證。
 */

export interface WebhookServerStatus {
  listening: boolean;
  port: number;
  error: string | null;
}

export interface WebhookServer {
  start(port: number): Promise<void>;
  stop(): Promise<void>;
  status(): WebhookServerStatus;
}

export type RequestHandler = (request: WebhookRequest) => Promise<WebhookResponse>;

const HEADERS_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_CONNECTIONS = 50;

const firstHeader = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

class BodyTooLarge extends Error {}

const readBody = (request: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const declared = Number(request.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY_BYTES) {
      reject(new BodyTooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_WEBHOOK_BODY_BYTES) {
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });

export const createWebhookServer = (handler: RequestHandler): WebhookServer => {
  let server: Server | null = null;
  let current: WebhookServerStatus = { listening: false, port: 0, error: null };

  const build = (): Server => {
    const created = createServer((request, response) => {
      const send = (status: number, body: string): void => {
        if (response.headersSent) return;
        response.writeHead(status, {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
          "Cache-Control": "no-store",
          Connection: "close"
        });
        response.end(body);
      };

      void (async () => {
        try {
          const body = await readBody(request);
          const headers: Record<string, string | undefined> = {};
          for (const [name, value] of Object.entries(request.headers)) {
            headers[name] = firstHeader(value);
          }
          // 路徑只取 pathname；query 一律不看。
          const path = (request.url ?? "/").split("?", 1)[0] ?? "/";
          const result = await handler({ method: request.method ?? "GET", path, headers, body });
          send(result.status, result.body);
        } catch (error) {
          if (error instanceof BodyTooLarge) {
            send(413, "payload too large");
            // 等回應送完再關連線，客戶端才有機會讀到 413；不繼續收後面的內容。
            response.once("finish", () => request.destroy());
            return;
          }
          send(500, "internal error");
        }
      })();
    });
    created.headersTimeout = HEADERS_TIMEOUT_MS;
    created.requestTimeout = REQUEST_TIMEOUT_MS;
    created.maxConnections = MAX_CONNECTIONS;
    return created;
  };

  return {
    async start(port) {
      if (server && current.listening && current.port === port) {
        return;
      }
      await this.stop();
      const created = build();
      server = created;
      await new Promise<void>((resolve) => {
        created.once("error", (error: NodeJS.ErrnoException) => {
          current = { listening: false, port, error: error.code === "EADDRINUSE" ? "連接埠已被其他程式使用" : "無法啟動接收端" };
          server = null;
          resolve();
        });
        created.listen({ host: WEBHOOK_HOST, port }, () => {
          const address = created.address();
          current = { listening: true, port: typeof address === "object" && address ? address.port : port, error: null };
          resolve();
        });
      });
    },

    async stop() {
      const closing = server;
      server = null;
      current = { ...current, listening: false };
      if (closing) {
        closing.closeAllConnections();
        await new Promise<void>((resolve) => closing.close(() => resolve()));
      }
    },

    status: () => ({ ...current })
  };
};
