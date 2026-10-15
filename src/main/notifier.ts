import { native } from "@main/native/bridge";

/** 顯示一則桌面通知（規則的「系統通知」動作使用）；系統不支援時回傳 false。 */
export const showDesktopNotification = (title: string, body: string, onClick?: () => void): boolean =>
  native().notify(title, body, onClick);
