/** Rust 端攔截的通道：外殼首次繪製後通知它顯示視窗（見 src-tauri/src/window.rs）。 */
export const SHELL_READY_CHANNEL = "window:ready";

/** 只送一次的「外殼已繪製」訊號；送失敗不影響畫面（Rust 有逾時後備）。 */
export const createShellReadySignal = (send: (channel: string) => Promise<unknown>): (() => void) => {
  let sent = false;
  return () => {
    if (sent) return;
    sent = true;
    void send(SHELL_READY_CHANNEL).catch(() => undefined);
  };
};
