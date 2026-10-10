import { builtinModules } from "node:module";

/**
 * 層級邊界守衛：渲染層（含 shared）與 preload 不得越界。
 *
 * - renderer / shared：不得 import electron、Node 內建模組、@main 或任何 vault 模組。
 * - preload：只允許 import electron；其餘同上（不得碰 Node 內建、@main、vault）。
 *
 * 目的是讓「渲染層絕不可能拿到金鑰或 Node 能力」由 CI 機器強制，而不是靠口頭約定。
 */

export type Layer = "renderer" | "shared" | "preload";

export interface SourceFile {
  path: string;
  source: string;
}

export interface Violation {
  path: string;
  specifier: string;
  reason: string;
}

const NODE_BUILTINS: ReadonlySet<string> = new Set(
  builtinModules.map((name) => name.replace(/^node:/, "").split("/")[0] as string)
);

// 涵蓋 import x from "…"、import "…"、export … from "…"、require("…")、import("…")。
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /\bimport\s+(?:type\s+)?[^"'`;]*?\s+from\s+["']([^"']+)["']/g,
  /\bimport\s+["']([^"']+)["']/g,
  /\bexport\s+(?:type\s+)?[^"'`;]*?\s+from\s+["']([^"']+)["']/g,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g
];

export const extractSpecifiers = (source: string): string[] => {
  const found = new Set<string>();
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier) {
        found.add(specifier);
      }
    }
  }
  return [...found];
};

const isNodeBuiltin = (specifier: string): boolean => {
  if (specifier.startsWith("node:")) {
    return true;
  }
  return NODE_BUILTINS.has(specifier.split("/")[0] as string);
};

const touchesMainProcess = (specifier: string): boolean =>
  specifier.startsWith("@main/") || specifier === "@main" || /(^|\/)src\/main(\/|$)/.test(specifier);

const touchesVault = (specifier: string): boolean => /(^|[\/@-])vault([\/.-]|$)/i.test(specifier);

const checkSpecifier = (layer: Layer, specifier: string): string | null => {
  if (touchesVault(specifier)) {
    return "密鑰保險庫只能存在於主程序";
  }
  if (touchesMainProcess(specifier)) {
    return "不得引用主程序模組";
  }
  if (specifier === "electron" || specifier.startsWith("electron/")) {
    return layer === "preload" ? null : "只有 preload 可以引用 electron";
  }
  if (isNodeBuiltin(specifier)) {
    return "不得引用 Node 內建模組";
  }
  return null;
};

export const findViolations = (layer: Layer, files: readonly SourceFile[]): Violation[] => {
  const violations: Violation[] = [];
  for (const file of files) {
    for (const specifier of extractSpecifiers(file.source)) {
      const reason = checkSpecifier(layer, specifier);
      if (reason) {
        violations.push({ path: file.path, specifier, reason });
      }
    }
  }
  return violations;
};
