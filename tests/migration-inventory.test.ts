import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { IPC, PUSH } from "@shared/ipc";

const doc = readFileSync("docs/tauri-migration-inventory.md", "utf8");

const rowsOf = (channel: string): number => doc.split("\n").filter((line) => line.startsWith(`| \`${channel}\` |`)).length;

describe("tauri migration inventory", () => {
  it("lists every invoke channel exactly once", () => {
    for (const channel of Object.values(IPC)) {
      assert.equal(rowsOf(channel), 1, `${channel} 在對照表中應恰好出現一次`);
    }
  });

  it("lists every push channel exactly once", () => {
    for (const channel of Object.values(PUSH)) {
      assert.equal(rowsOf(channel), 1, `${channel} 在對照表中應恰好出現一次`);
    }
  });

  it("states the real channel counts in its headings", () => {
    assert.match(doc, new RegExp(`## IPC invoke 通道（${Object.values(IPC).length} 個）`));
    assert.match(doc, new RegExp(`## IPC 推播通道（${Object.values(PUSH).length} 個）`));
  });
});
