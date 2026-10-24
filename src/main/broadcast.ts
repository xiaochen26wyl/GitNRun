import { native } from "@main/native/bridge";

/** 把資料推給所有開著的視窗（渲染層用 on* 方法訂閱）。 */
export const broadcast = (channel: string, payload: unknown): void => {
  native().push(channel, payload);
};
