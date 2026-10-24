import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { isValidAccelerator } from "@shared/launcher";

// 與 src-tauri/src/native/shortcut.rs 共用同一份夾具：TypeScript 的驗證器與 Rust 的解析器
// 對每個寫法的「接受／拒絕」要一致，已知 Rust 不支援的（需要 Shift 的符號、"+" 當主鍵）標成 unsupported。
interface Entry {
  accelerator: string;
  valid: boolean;
  rust: "ok" | "unsupported" | "invalid";
}
const entries: Entry[] = JSON.parse(readFileSync("tests/fixtures/accelerators.json", "utf8"));

const SHIFT_SYMBOLS = new Set([..."!@#$%^&*()_+{}:\"<>?|~"]);

describe("accelerator fixtures", () => {
  it("record exactly what the TypeScript validator accepts", () => {
    for (const entry of entries) {
      assert.equal(isValidAccelerator(entry.accelerator), entry.valid, JSON.stringify(entry.accelerator));
    }
  });

  it("mark only shifted symbols and a '+' main key as unsupported by the native shell", () => {
    for (const entry of entries) {
      const key = entry.accelerator.endsWith("++") ? "+" : (entry.accelerator.split("+").pop() ?? "");
      const expected = !entry.valid ? "invalid" : SHIFT_SYMBOLS.has(key) ? "unsupported" : "ok";
      assert.equal(entry.rust, expected, JSON.stringify(entry.accelerator));
    }
  });

  it("cover the default shortcut, every modifier spelling and the known gaps", () => {
    const has = (accelerator: string) => entries.some((entry) => entry.accelerator === accelerator);
    for (const accelerator of ["CommandOrControl+Shift+T", "Cmd+Shift+Return", "AltGr+T", "Meta+T", "Shift++", "Cmd+!"]) {
      assert.equal(has(accelerator), true, accelerator);
    }
  });
});
