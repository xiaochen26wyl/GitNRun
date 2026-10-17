import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ConfirmRequest } from "@shared/rule-runs";
import { SECRET_CLIPBOARD_TTL_MS, copySecretToClipboard, copySecretToClipboardChecked } from "@main/clipboard-secret";
import { setNative, type NativeConfirm } from "@main/native/bridge";
import { showConfirmDialog } from "@main/rules/confirm-dialog";
import { createFakeNative } from "./helpers/fake-native";

/** 原本直接呼叫 Electron 的幾處，改走 NativeBridge 之後的行為。 */

const request: ConfirmRequest = {
  ruleName: "deploy",
  projectName: "acme/web",
  branch: "main",
  pusher: "dev",
  headMessage: "ship it",
  actionType: "shell",
  summary: "pnpm deploy"
};

afterEach(() => setNative(null));

describe("showConfirmDialog", () => {
  it("maps the pressed button to a decision and bounces the dock once", async () => {
    for (const [pressed, expected] of [[1, "allow"], [0, "deny"]] as const) {
      const fake = createFakeNative({ confirm: async () => pressed });
      setNative(fake.bridge);
      assert.equal(await showConfirmDialog(request), expected);
      assert.equal(fake.callsOf("bounceDock").length, 1);
    }
  });

  it("asks with 'deny' as the default and cancel button", async () => {
    const fake = createFakeNative();
    setNative(fake.bridge);
    await showConfirmDialog(request);

    const [call] = fake.callsOf("confirm");
    const asked = call?.args[0] as NativeConfirm;
    assert.equal(asked.buttons[asked.defaultId], "拒絕");
    assert.equal(asked.cancelId, asked.defaultId);
    assert.equal(asked.kind, "warning");
  });

  it("reports 'timeout' when the dialog was closed by the abort signal, not by the user", async () => {
    const fake = createFakeNative({
      confirm: (req, options) =>
        new Promise((resolve) => {
          // 外殼在 signal 中止時關掉對話框，並以 cancelId 結束。
          options?.signal?.addEventListener("abort", () => resolve(req.cancelId));
        })
    });
    setNative(fake.bridge);
    assert.equal(await showConfirmDialog(request, 20), "timeout");
  });

  it("does not report a timeout when the user answered before the deadline", async () => {
    setNative(createFakeNative({ confirm: async () => 1 }).bridge);
    assert.equal(await showConfirmDialog(request, 20), "allow");
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
});

describe("copySecretToClipboard", () => {
  it("asks the shell for an expiring copy using the one-minute lifetime", () => {
    const fake = createFakeNative();
    setNative(fake.bridge);
    copySecretToClipboard("whsec_abc");
    assert.deepEqual(fake.callsOf("clipboardWriteExpiring").map((call) => call.args), [["whsec_abc", SECRET_CLIPBOARD_TTL_MS]]);
    assert.equal(SECRET_CLIPBOARD_TTL_MS, 60_000);
  });

  it("never throws or leaves an unhandled rejection when the shell cannot write", async () => {
    setNative(createFakeNative({ clipboardWriteExpiring: async () => Promise.reject(new Error("no clipboard")) }).bridge);
    assert.doesNotThrow(() => copySecretToClipboard("secret"));
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("lets the run-page caller report a clipboard write failure", async () => {
    setNative(createFakeNative({ clipboardWriteExpiring: async () => Promise.reject(new Error("no clipboard")) }).bridge);
    await assert.rejects(copySecretToClipboardChecked("secret"), /no clipboard/);
  });
});
