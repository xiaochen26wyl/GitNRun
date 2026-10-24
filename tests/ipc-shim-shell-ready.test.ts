import assert from "node:assert/strict";
import { test } from "node:test";
import { createShellReadySignal, SHELL_READY_CHANNEL } from "../src/shared/shell-ready";

test("shell ready signal is sent once on the window:ready channel", () => {
  const sent: string[] = [];
  const signal = createShellReadySignal(async (channel) => void sent.push(channel));
  signal();
  signal();
  assert.deepEqual(sent, [SHELL_READY_CHANNEL]);
});

test("a failing send does not throw", async () => {
  const signal = createShellReadySignal(() => Promise.reject(new Error("boom")));
  assert.doesNotThrow(signal);
  await new Promise((resolve) => setImmediate(resolve));
});
