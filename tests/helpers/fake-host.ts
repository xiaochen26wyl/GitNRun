import { connect, type Socket } from "node:net";
import { createLineDecoder } from "@main/sidecar/framing";
import { PROTOCOL_VERSION, encodeFrame, parseFrame, type Frame, type HostInfo } from "@main/sidecar/protocol";

/** 假的外殼（Rust）：連到 sidecar 的 unix socket，收發 NDJSON 訊息。 */
export interface FakeHost {
  socket: Socket;
  frames: Frame[];
  send(frame: Frame): void;
  waitFor(predicate: (frame: Frame) => boolean, timeoutMs?: number): Promise<Frame>;
  closed: Promise<void>;
  close(): void;
}

export const connectFakeHost = (socketPath: string): Promise<FakeHost> =>
  new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const frames: Frame[] = [];
    const decoder = createLineDecoder();
    const waiters: Array<() => void> = [];
    const closed = new Promise<void>((done) => socket.on("close", () => done()));

    socket.on("data", (chunk) => {
      for (const line of decoder.push(chunk)) {
        const frame = parseFrame(line);
        if (frame) frames.push(frame);
      }
      for (const wake of waiters.splice(0)) wake();
    });
    socket.on("error", reject);
    socket.once("connect", () => {
      resolve({
        socket,
        frames,
        send: (frame) => void socket.write(encodeFrame(frame)),
        waitFor: (predicate, timeoutMs = 2000) =>
          new Promise<Frame>((ok, fail) => {
            const timer = setTimeout(() => fail(new Error("fake host: timed out waiting for frame")), timeoutMs);
            const check = (): void => {
              const found = frames.find(predicate);
              if (found) {
                clearTimeout(timer);
                ok(found);
              } else {
                waiters.push(check);
              }
            };
            check();
          }),
        closed,
        close: () => socket.destroy()
      });
    });
  });

export const hostInfo = (token: string, overrides: Partial<HostInfo> = {}): HostInfo => ({
  v: PROTOCOL_VERSION,
  token,
  appName: "GitNRun",
  appVersion: "0.0.0-test",
  platform: "darwin",
  dataDir: "/tmp/gitnrun-test",
  packaged: false,
  ...overrides
});
