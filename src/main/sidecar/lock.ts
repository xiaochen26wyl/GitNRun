import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

/**
 * 單一寫入者：同一份資料庫同時只能有一個 sidecar。以 pid 檔實作，
 * 檔案裡的 pid 對應的行程已經不在了就視為殘留，接手。
 */

export class LockHeldError extends Error {
  readonly pid: number;

  constructor(pid: number) {
    super(`sidecar: another sidecar (pid ${pid}) is using this data directory`);
    this.name = "LockHeldError";
    this.pid = pid;
  }
}

export interface Lock {
  release(): void;
}

const defaultIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM：行程存在，只是不屬於我們。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const readPid = (path: string): number | null => {
  try {
    const value = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
};

export const acquireLock = (path: string, options: { pid?: number; isAlive?: (pid: number) => boolean } = {}): Lock => {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? defaultIsAlive;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, String(pid));
      } finally {
        closeSync(fd);
      }
      return {
        release() {
          // 只放掉自己的；萬一檔案已經被別人接手就不要動它。
          if (readPid(path) === pid) {
            try {
              unlinkSync(path);
            } catch {
              // 已經不在了。
            }
          }
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const holder = readPid(path);
      if (holder !== null && holder !== pid && isAlive(holder)) {
        throw new LockHeldError(holder);
      }
      try {
        unlinkSync(path);
      } catch {
        // 別人剛好先清掉了，下一輪再試。
      }
    }
  }
  throw new Error("sidecar: could not acquire the data directory lock");
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 開發時 tsx watch 會先停掉舊的、再啟動新的，兩者之間可能有一小段重疊；
 * 對方還活著就等一下再試，等不到才放棄。
 */
export const acquireLockWithRetry = async (
  path: string,
  options: { timeoutMs?: number; intervalMs?: number; pid?: number; isAlive?: (pid: number) => boolean } = {}
): Promise<Lock> => {
  const deadline = Date.now() + (options.timeoutMs ?? 5_000);
  for (;;) {
    try {
      return acquireLock(path, options);
    } catch (error) {
      if (!(error instanceof LockHeldError) || Date.now() >= deadline) {
        throw error;
      }
      await sleep(options.intervalMs ?? 100);
    }
  }
};
