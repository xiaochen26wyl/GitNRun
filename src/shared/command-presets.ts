/** 常用指令模板（規則的自訂指令、一鍵啟動終端機的映射都可以快速選用）。 */

export interface CommandPreset {
  id: string;
  label: string;
  command: string;
}

export const COMMAND_PRESETS: readonly CommandPreset[] = [
  { id: "git-pull", label: "git pull（只允許快轉）", command: "git pull --ff-only" },
  { id: "git-fetch", label: "git fetch --all --prune", command: "git fetch --all --prune" },
  { id: "git-status", label: "git status", command: "git status --short --branch" },
  { id: "pnpm-install", label: "安裝依賴（pnpm，鎖定版本）", command: "pnpm install --frozen-lockfile" },
  { id: "pnpm-test", label: "執行測試（pnpm）", command: "pnpm test" },
  { id: "npm-ci", label: "安裝依賴（npm ci）", command: "npm ci" },
  { id: "npm-test", label: "執行測試（npm）", command: "npm test" },
  { id: "open-vscode", label: "用 VS Code 開啟專案", command: "code ." }
];
