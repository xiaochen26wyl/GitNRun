import { clipboard } from "electron";

export const SECRET_CLIPBOARD_TTL_MS = 60_000;

/**
 * 把 secret 放進剪貼簿讓使用者貼到 GitHub，一分鐘後自動清掉。
 * 只在剪貼簿裡「還是這個 secret」的時候才清，不會誤刪使用者後來複製的其他東西。
 */
export const copySecretToClipboard = (secret: string): void => {
  clipboard.writeText(secret);
  setTimeout(() => {
    if (clipboard.readText() === secret) {
      clipboard.clear();
    }
  }, SECRET_CLIPBOARD_TTL_MS).unref();
};
