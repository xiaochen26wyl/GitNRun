/** 文件空間：專案 README 由本機路徑即時發現；手動捷徑只保存路徑與開啟方式，不同步到任何雲端。 */

export const DOCUMENT_OPENERS = ["default", "finder", "cursor", "vscode", "textedit"] as const;
export type DocumentOpener = (typeof DOCUMENT_OPENERS)[number];

export interface DocumentShortcut {
  id: number;
  label: string;
  path: string;
  opener: DocumentOpener;
  source?: "project-readme";
  createdAt: number;
  updatedAt: number;
}

export interface DocumentShortcutInput {
  id?: number;
  label?: string;
  path: string;
  opener?: DocumentOpener;
}

export const DOCUMENT_OPENER_LABELS: Record<DocumentOpener, string> = {
  default: "預設 App",
  finder: "Finder",
  cursor: "Cursor",
  vscode: "VS Code",
  textedit: "TextEdit"
};

export const MAX_DOCUMENT_SHORTCUTS = 200;
export const MAX_DOCUMENT_LABEL_LENGTH = 120;
export const MAX_DOCUMENT_PATH_LENGTH = 4096;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export type DocumentShortcutValidation =
  | { ok: true; value: Required<DocumentShortcutInput> }
  | { ok: false; errors: string[] };

const basename = (path: string): string => path.split("/").filter(Boolean).at(-1) ?? path;

export const validateDocumentShortcutInput = (raw: unknown): DocumentShortcutValidation => {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["輸入格式不正確"] };
  }
  const input = raw as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => !["id", "label", "path", "opener"].includes(key));
  if (unknown.length > 0) {
    errors.push("有不認得的欄位");
  }

  let id = 0;
  if (input.id !== undefined) {
    if (typeof input.id !== "number" || !Number.isSafeInteger(input.id) || input.id <= 0) {
      errors.push("捷徑識別不正確");
    } else {
      id = input.id;
    }
  }

  const path = typeof input.path === "string" ? input.path.trim() : "";
  if (path.length === 0 || path.length > MAX_DOCUMENT_PATH_LENGTH || CONTROL_CHARACTERS.test(path) || !path.startsWith("/")) {
    errors.push("路徑必須是不含控制字元的絕對路徑");
  }

  let label = input.label === undefined ? basename(path) : typeof input.label === "string" ? input.label.trim() : "";
  if (label.length === 0) {
    label = basename(path);
  }
  if (label.length === 0 || label.length > MAX_DOCUMENT_LABEL_LENGTH || CONTROL_CHARACTERS.test(label)) {
    errors.push("名稱不正確");
  }

  const opener =
    input.opener === undefined
      ? "default"
      : DOCUMENT_OPENERS.find((candidate) => candidate === input.opener);
  if (!opener) {
    errors.push("開啟方式不正確");
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: { id, label, path, opener: opener ?? "default" } };
};
