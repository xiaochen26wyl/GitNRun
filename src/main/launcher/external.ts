/**
 * 外部開啟請求（自訂協定網址、拖到 Dock 圖示的資料夾）的收件匣。
 *
 * macOS 可能在 App 還沒準備好時就送來 open-url／open-file（例如從 Finder 的快速動作冷啟動），
 * 所以要在一開始就接住，等啟動器準備好才依序處理，不能漏掉也不能重複處理。
 */

export type ExternalRequest = { kind: "url"; value: string } | { kind: "file"; value: string };

export interface ExternalOpenGate {
  push(request: ExternalRequest): void;
  /** 接上處理函式；先前累積的請求會依序交給它。 */
  attach(handler: (request: ExternalRequest) => void): void;
}

const MAX_PENDING = 20;

export const createExternalOpenGate = (): ExternalOpenGate => {
  const pending: ExternalRequest[] = [];
  let handler: ((request: ExternalRequest) => void) | null = null;

  return {
    push(request) {
      if (handler) {
        handler(request);
        return;
      }
      // 準備好之前最多留幾筆，避免不斷被塞請求而無限增長。
      if (pending.length < MAX_PENDING) {
        pending.push(request);
      }
    },

    attach(next) {
      handler = next;
      for (const request of pending.splice(0)) {
        next(request);
      }
    }
  };
};
