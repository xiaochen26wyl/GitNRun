import { matchGlob } from "@shared/glob";
import { hasWildcard, normalizeFolderPath, type LaunchTarget, type TerminalMapping } from "@shared/launcher";
import type { Project } from "@shared/projects";

/** 從目標資料夾往上列出它自己與所有上層資料夾（不含根目錄 "/"）。 */
export const ancestorsOf = (path: string): string[] => {
  const result: string[] = [];
  let current = normalizeFolderPath(path);
  while (current.length > 1) {
    result.push(current);
    const cut = current.lastIndexOf("/");
    current = cut <= 0 ? "/" : current.slice(0, cut);
  }
  return result;
};

const matchesPattern = (pattern: string, folder: string): boolean =>
  hasWildcard(pattern) ? matchGlob(pattern, folder, { pathAware: true }) : pattern === folder;

export interface ResolvedMapping {
  mapping: TerminalMapping;
  /** 符合的是目標資料夾往上第幾層；0 = 目標資料夾自己。 */
  distance: number;
}

/**
 * 找出最適用的映射。
 *
 * 一條映射「適用」於資料夾 X：樣式符合 X 本身；或它勾了「包含子資料夾」且符合 X 的某一層上層資料夾。
 * 多條適用時，依序比較：離 X 越近越好 → 精確路徑優於萬用符號 → 路徑中固定的字元越多越好 → 先建立的優先。
 */
export const resolveMapping = (mappings: readonly TerminalMapping[], targetPath: string): ResolvedMapping | null => {
  const chain = ancestorsOf(targetPath);
  const candidates: Array<{ mapping: TerminalMapping; distance: number; wildcard: boolean; literal: number }> = [];

  for (const mapping of mappings) {
    const pattern = normalizeFolderPath(mapping.pathPattern);
    const reach = mapping.recursive ? chain.length : 1;
    for (let distance = 0; distance < reach; distance += 1) {
      const folder = chain[distance];
      if (folder !== undefined && matchesPattern(pattern, folder)) {
        candidates.push({ mapping, distance, wildcard: hasWildcard(pattern), literal: pattern.replace(/[*?]/g, "").length });
        break;
      }
    }
  }

  candidates.sort(
    (a, b) =>
      a.distance - b.distance ||
      Number(a.wildcard) - Number(b.wildcard) ||
      b.literal - a.literal ||
      a.mapping.id - b.mapping.id
  );
  const best = candidates[0];
  return best ? { mapping: best.mapping, distance: best.distance } : null;
};

/**
 * 快速選單用的目標：已設定本機路徑的專案，加上不含萬用符號的映射路徑。
 * 同一個資料夾只出現一次（專案名稱優先）。
 */
export const buildLaunchTargets = (projects: readonly Project[], mappings: readonly TerminalMapping[]): LaunchTarget[] => {
  const seen = new Set<string>();
  const targets: LaunchTarget[] = [];
  const add = (label: string, folder: string): void => {
    const normalized = normalizeFolderPath(folder);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      targets.push({ label, folder: normalized });
    }
  };
  for (const project of projects) {
    if (project.enabled && project.localPath) {
      add(project.name, project.localPath);
    }
  }
  for (const mapping of mappings) {
    if (!hasWildcard(mapping.pathPattern)) {
      add(mapping.pathPattern.split("/").pop() || mapping.pathPattern, mapping.pathPattern);
    }
  }
  return targets;
};
