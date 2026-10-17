import net from "node:net";
import { MANUAL_START_PORTS } from "../src/shared/reserved-ports";

/**
 * GitNRun 自己的 dev server 要用哪個 port。
 * 沒指定 PORT 時從 Vite 的預設起點往後找，但撇除留給手動啟動的號碼（見 src/shared/reserved-ports.ts）；
 * 這個檔案由 electron.vite.config.ts 在啟動時載入，所以只能用 Node 內建模組與沒有別名的相對路徑。
 */

/** Vite 的預設起點。 */
export const DEV_PORT_START = 5173;

const MAX_PORT = 65535;

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

/** 與專案啟動頁相同的探測方式：Vite 在新版 Node 常只綁 ::1，所以 IPv4 與 IPv6 都要探。 */
export const isPortBusy = async (port: number, timeoutMs = 400): Promise<boolean> => {
  const results = await Promise.all([connects("127.0.0.1", port, timeoutMs), connects("::1", port, timeoutMs)]);
  return results.some(Boolean);
};

const parsePort = (raw: string | undefined): number | null => {
  const value = Number(raw);
  return raw !== undefined && Number.isInteger(value) && value > 0 && value <= MAX_PORT ? value : null;
};

export interface DevPortOptions {
  env?: Readonly<Record<string, string | undefined>>;
  start?: number;
  reserved?: readonly number[];
  isBusy?: (port: number) => Promise<boolean>;
}

/**
 * PORT 合法就沿用（專案啟動頁會以 PORT 傳入）；PORT 落在保留號碼會直接報錯，不默默改號。
 * 沒給 PORT 時，從 start 起找第一個不在保留清單、且目前沒人監聽的 port。
 */
export const resolveDevPort = async ({
  env = process.env,
  start = DEV_PORT_START,
  reserved = MANUAL_START_PORTS,
  isBusy = isPortBusy
}: DevPortOptions = {}): Promise<number> => {
  const requested = parsePort(env.PORT);
  if (requested !== null) {
    if (reserved.includes(requested)) {
      throw new Error(`PORT ${requested} 留給手動啟動的專案，GitNRun 的 dev server 不能占用；請改用其他號碼，或不要指定 PORT`);
    }
    return requested;
  }
  for (let port = start; port <= MAX_PORT; port += 1) {
    if (reserved.includes(port)) continue;
    if (!(await isBusy(port))) return port;
  }
  throw new Error(`從 ${start} 起找不到可用的 dev server port`);
};
