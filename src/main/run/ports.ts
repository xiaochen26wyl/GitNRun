import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { MANUAL_START_PORTS } from "@shared/reserved-ports";
import { urlForPort, type RunRole } from "@shared/run";

/**
 * port 的分配、偵測與記錄。
 * 動態 port 向作業系統要空位；狀態用 TCP 連線探測（同時探 IPv4 與 IPv6）。
 */

export interface BoundPort {
  server: net.Server;
  port: number;
}

/** 向作業系統要一個目前沒人用的 port 並先占著，由呼叫端負責關閉。 */
const bindFreePort = (): Promise<BoundPort> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1", exclusive: true }, () => {
      const address = server.address();
      if (address !== null && typeof address === "object") {
        resolve({ server, port: address.port });
      } else {
        server.close();
        reject(new Error("無法取得空的 port"));
      }
    });
  });

/**
 * 一次向作業系統要 count 個彼此不同的空 port（同時占著再一起放掉，所以不會重複）。
 * 固定 port（excluded）與留給手動啟動的 5173、5174 一律不發出去。
 */
export const allocatePorts = async (
  count: number,
  excluded: readonly number[] = [],
  bind: () => Promise<BoundPort> = bindFreePort
): Promise<number[]> => {
  const servers: net.Server[] = [];
  const blocked = new Set([...MANUAL_START_PORTS, ...excluded]);
  try {
    const ports: number[] = [];
    for (let index = 0; index < count; index += 1) {
      let assigned = false;
      for (let attempt = 0; attempt < 128 && !assigned; attempt += 1) {
        const { server, port } = await bind();
        if (blocked.has(port)) {
          await new Promise<void>((resolve) => server.close(() => resolve()));
          continue;
        }
        servers.push(server);
        blocked.add(port);
        ports.push(port);
        assigned = true;
      }
      if (!assigned) throw new Error("無法取得不與固定 port 衝突的空 port");
    }
    return ports;
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
};

const connects = (host: string, port: number, timeoutMs: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (result: boolean): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });

/** Vite、Next 在新版 Node 常只綁 ::1，所以兩個位址都要探。 */
export const probePort = async (port: number, timeoutMs = 400): Promise<boolean> => {
  const results = await Promise.all([connects("127.0.0.1", port, timeoutMs), connects("::1", port, timeoutMs)]);
  return results.some(Boolean);
};

export interface PortsFileService {
  role: RunRole;
  port: number;
}

/**
 * 寫入專案的 .dev/ports.json，給專案內的腳本（例如手機端）讀取。
 * 這只是提示：讀的人使用前要自己探測服務是否還活著。寫不進去不影響啟動，回傳 false。
 */
export const writePortsFile = async (folder: string, services: Readonly<Record<string, PortsFileService>>, now: number): Promise<boolean> => {
  try {
    const dir = join(folder, ".dev");
    const existing = await lstat(dir).catch(() => null);
    if (existing?.isSymbolicLink()) {
      return false;
    }
    await mkdir(dir, { recursive: true });
    const body = {
      updatedAt: new Date(now).toISOString(),
      services: Object.fromEntries(
        Object.entries(services).map(([name, service]) => [name, { role: service.role, port: service.port, url: urlForPort(service.port) }])
      )
    };
    await writeFile(join(dir, "ports.json"), `${JSON.stringify(body, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
};

/**
 * 讀回上次寫入的「服務名稱 -> port」；GitNRun 重開（例如終端機 dev 模式重啟主程序）後，
 * 記憶體裡的 session 會清空，靠這份檔案配合即時探測，把還活著的服務重新認回來。
 * 檔案不存在、是 symlink、或格式不對都回傳 null，不影響啟動。
 */
export const readPortsFile = async (folder: string): Promise<Record<string, number> | null> => {
  try {
    const dir = join(folder, ".dev");
    const dirStat = await lstat(dir).catch(() => null);
    if (dirStat === null || dirStat.isSymbolicLink()) {
      return null;
    }
    const raw = JSON.parse(await readFile(join(dir, "ports.json"), "utf8")) as unknown;
    const services =
      typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).services : null;
    if (typeof services !== "object" || services === null) {
      return null;
    }
    const result: Record<string, number> = {};
    for (const [name, value] of Object.entries(services as Record<string, unknown>)) {
      const port = typeof value === "object" && value !== null ? (value as Record<string, unknown>).port : undefined;
      if (typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536) {
        result[name] = port;
      }
    }
    return result;
  } catch {
    return null;
  }
};
