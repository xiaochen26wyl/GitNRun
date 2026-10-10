import { lstat, mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { urlForPort, type RunRole } from "@shared/run";

/**
 * port 的分配、偵測與記錄。
 * 不內建任何偏好號碼：向作業系統要空位；狀態用 TCP 連線探測（同時探 IPv4 與 IPv6）。
 */

/** 一次向作業系統要 count 個彼此不同的空 port（同時占著再一起放掉，所以不會重複）。 */
export const allocatePorts = async (count: number): Promise<number[]> => {
  const servers: net.Server[] = [];
  try {
    const ports = await Promise.all(
      Array.from({ length: count }, () =>
        new Promise<number>((resolve, reject) => {
          const server = net.createServer();
          servers.push(server);
          server.once("error", reject);
          server.listen({ port: 0, host: "127.0.0.1", exclusive: true }, () => {
            const address = server.address();
            if (address !== null && typeof address === "object") {
              resolve(address.port);
            } else {
              reject(new Error("無法取得空的 port"));
            }
          });
        })
      )
    );
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
