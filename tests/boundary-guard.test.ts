import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractSpecifiers, findViolations } from "../scripts/boundary";

const file = (source: string) => [{ path: "fixture.ts", source }];

describe("extractSpecifiers", () => {
  it("finds every import form", () => {
    const specifiers = extractSpecifiers(`
      import fs from "node:fs";
      import type { A } from '@shared/types';
      import "./side-effect";
      export { b } from "../b";
      const c = require("child_process");
      const d = await import("electron");
    `);
    assert.deepEqual(
      specifiers.sort(),
      ["../b", "./side-effect", "@shared/types", "child_process", "electron", "node:fs"].sort()
    );
  });
});

describe("findViolations", () => {
  it("fails a renderer that imports electron or Node built-ins", () => {
    assert.equal(findViolations("renderer", file(`import { ipcRenderer } from "electron";`)).length, 1);
    assert.equal(findViolations("renderer", file(`import { readFile } from "node:fs/promises";`)).length, 1);
    assert.equal(findViolations("renderer", file(`import path from "path";`)).length, 1);
    assert.equal(findViolations("renderer", file(`const cp = require("child_process");`)).length, 1);
  });

  it("fails any layer that reaches into the main process or the vault", () => {
    for (const layer of ["renderer", "shared", "preload"] as const) {
      assert.equal(findViolations(layer, file(`import { x } from "@main/vault";`)).length >= 1, true);
      assert.equal(findViolations(layer, file(`import { x } from "../main/vault/store";`)).length >= 1, true);
      assert.equal(findViolations(layer, file(`import { x } from "@main/db";`)).length, 1);
      assert.equal(findViolations(layer, file(`import { getVault } from "@main/vault/runtime";`)).length >= 1, true);
      assert.equal(findViolations(layer, file(`import { createVault } from "../../main/vault/vault";`)).length >= 1, true);
    }
  });

  it("lets preload import electron but nothing else from Node", () => {
    assert.equal(findViolations("preload", file(`import { contextBridge } from "electron";`)).length, 0);
    assert.equal(findViolations("preload", file(`import { join } from "node:path";`)).length, 1);
  });

  it("keeps shared pure", () => {
    assert.equal(findViolations("shared", file(`import { app } from "electron";`)).length, 1);
    assert.equal(findViolations("shared", file(`import type { Foo } from "./types";`)).length, 0);
  });

  it("passes ordinary renderer imports", () => {
    const source = `
      import { useState } from "react";
      import type { AppInfo } from "@shared/ipc";
      import { App } from "./App";
    `;
    assert.deepEqual(findViolations("renderer", file(source)), []);
  });
});
