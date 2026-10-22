/** dev 通關帳號的畫面規則（純函式）：能不能複製、輸入是否合法，限制與主程序的 normalizeRunAccount 一致。 */

import { MAX_ACCOUNT_LENGTH, normalizeRunAccount } from "@shared/run";

export type AccountDraft = { ok: true; account: string } | { ok: false; reason: string };

/** 輸入框內容轉成可儲存的帳號；空字串合法（代表清除）。 */
export const accountDraftOf = (input: string): AccountDraft => {
  const account = normalizeRunAccount(input);
  if (account !== null) return { ok: true, account };
  return { ok: false, reason: input.trim().length > MAX_ACCOUNT_LENGTH ? `帳號不能超過 ${MAX_ACCOUNT_LENGTH} 個字` : "帳號不能含換行或控制字元" };
};

/** 複製按鈕的狀態：沒設定帳號就不能複製，並說明原因。 */
export const accountCopyState = (account: string): { canCopy: boolean; reason: string } =>
  account.trim() === "" ? { canCopy: false, reason: "先設定帳號" } : { canCopy: true, reason: "" };
