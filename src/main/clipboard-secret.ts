import { native } from "@main/native/bridge";

export const SECRET_CLIPBOARD_TTL_MS = 60_000;

/** 需要回報複製成敗的操作使用這個版本。 */
export const copySecretToClipboardChecked = (secret: string): Promise<void> =>
  native().clipboardWriteExpiring(secret, SECRET_CLIPBOARD_TTL_MS);

/**
 * 把 secret 放進剪貼簿讓使用者貼到 GitHub，一分鐘後自動清掉。
 * 只在剪貼簿裡「還是這個 secret」的時候才清，不會誤刪使用者後來複製的其他東西。
 */
export const copySecretToClipboard = (secret: string): void => {
  void copySecretToClipboardChecked(secret).catch(() => undefined);
};
