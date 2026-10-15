import { MAX_FRAME_BYTES } from "@main/sidecar/protocol";

/** 一行超過上限，或剩下沒收完的半行已經超過上限。 */
export class FrameTooLargeError extends Error {
  constructor() {
    super("sidecar: frame too large");
    this.name = "FrameTooLargeError";
  }
}

export interface LineDecoder {
  /** 餵入一段原始資料（可能是半行、多行，或在多位元組字元中間切斷），回傳其中已經完整的行。 */
  push(chunk: Buffer): string[];
}

const NEWLINE = 0x0a;

/**
 * 逐行切分。在位元組層級找換行字元，整行收齊才轉成字串，
 * 所以不會把 UTF-8 多位元組字元從中間切開；空行直接略過。
 */
export const createLineDecoder = (maxBytes: number = MAX_FRAME_BYTES): LineDecoder => {
  let pending: Buffer[] = [];
  let pendingBytes = 0;

  return {
    push(chunk) {
      const lines: string[] = [];
      let start = 0;
      for (;;) {
        const newline = chunk.indexOf(NEWLINE, start);
        if (newline === -1) {
          break;
        }
        const piece = chunk.subarray(start, newline);
        if (pendingBytes + piece.length > maxBytes) {
          throw new FrameTooLargeError();
        }
        const line = pending.length === 0 ? piece : Buffer.concat([...pending, piece]);
        pending = [];
        pendingBytes = 0;
        if (line.length > 0) {
          lines.push(line.toString("utf8"));
        }
        start = newline + 1;
      }

      const rest = chunk.subarray(start);
      if (rest.length > 0) {
        if (pendingBytes + rest.length > maxBytes) {
          throw new FrameTooLargeError();
        }
        // 複製一份，避免之後來源 buffer 被重用而改到我們留著的內容。
        pending.push(Buffer.from(rest));
        pendingBytes += rest.length;
      }
      return lines;
    }
  };
};
