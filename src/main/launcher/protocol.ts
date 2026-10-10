/**
 * 自訂協定 gitnrun://launch?path=<資料夾>（給 Finder 右鍵的快速動作等外部入口用）。
 * 來源不可信（任何網頁、程式都能開這種網址），所以解析非常嚴格：只認 launch 這一個動作、
 * 只認 path 這一個參數、路徑必須是絕對路徑。能不能真的啟動由呼叫端再依映射決定。
 */

export const PROTOCOL_SCHEME = "gitnrun";
const MAX_URL_LENGTH = 5000;

export type ParsedLaunchUrl = { ok: true; folder: string } | { ok: false };

export const parseLaunchUrl = (raw: string): ParsedLaunchUrl => {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) {
    return { ok: false };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false };
  }
  if (url.protocol !== `${PROTOCOL_SCHEME}:` || url.hostname !== "launch" || url.username !== "" || url.password !== "" || url.port !== "") {
    return { ok: false };
  }
  if ((url.pathname !== "" && url.pathname !== "/") || url.hash !== "") {
    return { ok: false };
  }
  const keys = [...url.searchParams.keys()];
  const folders = url.searchParams.getAll("path");
  if (keys.length !== 1 || keys[0] !== "path" || folders.length !== 1) {
    return { ok: false };
  }
  const folder = folders[0] as string;
  if (!folder.startsWith("/") || folder.includes("\0") || folder.length > 4096 || /[\u0000-\u001f\u007f]/.test(folder)) {
    return { ok: false };
  }
  return { ok: true, folder };
};
