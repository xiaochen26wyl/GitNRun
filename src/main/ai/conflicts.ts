/**
 * 合併衝突預測用本機 git 判斷（`git merge-tree --write-tree`，需要 git 2.38 以上）：
 * 確定性、不花 API 費用、不改動工作區。AI 只負責把結果用白話解釋。
 *
 * 輸出格式：第一行是結果 tree 的 OID；有衝突時接著是衝突的檔名（--name-only），
 * 空一行之後是 git 的說明訊息。結束碼 0 = 乾淨、1 = 有衝突。
 */

export type MergeTreeOutcome =
  | { kind: "clean"; messages: string }
  | { kind: "conflicts"; files: string[]; messages: string }
  | { kind: "unsupported" }
  | { kind: "error"; detail: string };

export const parseMergeTree = (code: number, stdout: string, stderr: string): MergeTreeOutcome => {
  if (code === 0 || code === 1) {
    const lines = stdout.split("\n");
    let index = 1;
    const files: string[] = [];
    while (index < lines.length && lines[index] !== "") {
      files.push(lines[index] as string);
      index += 1;
    }
    const messages = lines.slice(index + 1).join("\n").trim();
    const unique = [...new Set(files)];
    return code === 0 ? { kind: "clean", messages } : { kind: "conflicts", files: unique, messages };
  }
  // 舊版 git 不認得 --write-tree：用法錯誤（129）或「不認得的選項」。
  if (code === 129 || /unknown option|usage: git merge-tree/i.test(stderr)) {
    return { kind: "unsupported" };
  }
  return { kind: "error", detail: stderr.trim() };
};
