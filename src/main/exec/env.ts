import type { PushEvent } from "@shared/events";
import type { Project } from "@shared/projects";

/**
 * 子行程的環境變數。
 *
 * 不繼承本程式的完整 process.env（裡面可能有任何東西），只放必要的白名單；
 * 事件內容（分支、訊息、推送者）以 PW_* 環境變數傳入，不拼進指令字串。
 */

export const FALLBACK_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

const PASSTHROUGH = ["HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "SSH_AUTH_SOCK"] as const;

// 只允許這些傳輸協定：擋掉 ext::／fd:: 這類會執行任意指令的 git 傳輸。
export const GIT_ALLOWED_PROTOCOLS = "file:git:http:https:ssh";

/**
 * 預設環境。從 Finder／Dock 啟動的 App 只有極簡的 PATH，找不到 homebrew、nvm 裡的程式，
 * 所以 PATH 會優先採用「使用者登入 shell 解析出來的 PATH」（resolvedPath）。
 */
export const buildBaseEnv = (source: Readonly<Record<string, string | undefined>>, resolvedPath: string | null): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH) {
    const value = source[key];
    if (value) {
      env[key] = value;
    }
  }
  env.PATH = resolvedPath ?? source.PATH ?? FALLBACK_PATH;
  env.TERM = "dumb";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ALLOW_PROTOCOL = GIT_ALLOWED_PROTOCOLS;
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  return env;
};

const MAX_ENV_VALUE = 4000;

const clean = (value: string): string => value.replaceAll("\0", "").slice(0, MAX_ENV_VALUE);

/** 事件資料（永遠只當資料，用環境變數傳給指令）。 */
export const eventEnv = (event: PushEvent, project: Pick<Project, "name" | "localPath">): Record<string, string> => ({
  PW_PROJECT: clean(project.name),
  PW_BRANCH: clean(event.branch),
  PW_REF: clean(event.ref),
  PW_EVENT_TYPE: event.eventType,
  PW_PUSHER: clean(event.pusher ?? ""),
  PW_MESSAGE: clean(event.headMessage),
  PW_SHA: event.afterSha,
  PW_BEFORE_SHA: event.beforeSha ?? "",
  PW_FILE_COUNT: String(event.fileCount),
  PW_COMMIT_COUNT: String(event.commits.length),
  PW_LOCAL_PATH: clean(project.localPath ?? "")
});

/** 前面動作的輸出（如 ai_summary）→ PW_AI_SUMMARY；名稱只允許小寫英數與底線。 */
export const outputsEnv = (variables: Readonly<Record<string, string>> | undefined): Record<string, string> =>
  Object.fromEntries(
    Object.entries(variables ?? {})
      .filter(([name]) => /^[a-z][a-z0-9_]{0,40}$/.test(name))
      .map(([name, value]) => [`PW_${name.toUpperCase()}`, clean(value)])
  );

const PATH_MARKER = "__PW_PATH__";

/** 從登入 shell 的輸出取出 PATH（兩個標記之間），避免 profile 印出的其他內容干擾。 */
export const parsePathFromShellOutput = (output: string): string | null => {
  const start = output.indexOf(PATH_MARKER);
  const end = output.lastIndexOf(PATH_MARKER);
  if (start === -1 || end <= start) {
    return null;
  }
  const value = output.slice(start + PATH_MARKER.length, end).trim();
  return value.length > 0 && !value.includes("\n") && value.startsWith("/") ? value : null;
};

export const PATH_PROBE_ARGS = ["-ilc", `printf '%s%s%s' ${PATH_MARKER} "$PATH" ${PATH_MARKER}`] as const;

export type ShellProbe = (file: string, args: readonly string[]) => Promise<{ code: number | null; stdout: string }>;

/** 問使用者的登入 shell「你的 PATH 是什麼」；失敗就回傳 null，由呼叫端用備用值。 */
export const resolveLoginPath = async (probe: ShellProbe, shell = "/bin/zsh"): Promise<string | null> => {
  try {
    const result = await probe(shell, PATH_PROBE_ARGS);
    return result.code === 0 ? parsePathFromShellOutput(result.stdout) : null;
  } catch {
    return null;
  }
};
