import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { sidecarNodeOptions } from "../scripts/dev-helpers";
import { SIDECAR_NODE_FLAGS } from "../scripts/node-runtime";

describe("sidecar node flags", () => {
  it("are the same list in the TypeScript scripts and in the Rust launcher", () => {
    const rust = readFileSync("src-tauri/src/launch.rs", "utf8");
    const match = /pub const NODE_FLAGS: \[&str; (\d+)\] = \[([^\]]*)\];/.exec(rust);
    assert.ok(match, "launch.rs 找不到 NODE_FLAGS");
    const rustFlags = [...(match[2] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    assert.equal(Number(match[1]), rustFlags.length, "陣列長度宣告與內容不符");
    assert.deepEqual(rustFlags, [...SIDECAR_NODE_FLAGS]);
  });

  it("cap the young generation (the memory saver) and keep a generous old-generation limit", () => {
    assert.ok(SIDECAR_NODE_FLAGS.includes("--max-semi-space-size=1"));
    const old = SIDECAR_NODE_FLAGS.find((flag) => flag.startsWith("--max-old-space-size="));
    assert.ok(old);
    // 存活資料只有約 7 MB；上限太低會讓正常的大查詢崩潰，所以不低於 96。
    assert.ok(Number(old.split("=")[1]) >= 96);
  });

  it("are appended to NODE_OPTIONS in dev without dropping what the user already set", () => {
    assert.equal(sidecarNodeOptions(undefined), SIDECAR_NODE_FLAGS.join(" "));
    assert.equal(sidecarNodeOptions("  --trace-warnings "), `--trace-warnings ${SIDECAR_NODE_FLAGS.join(" ")}`);
    assert.equal(sidecarNodeOptions(""), SIDECAR_NODE_FLAGS.join(" "));
  });
});
