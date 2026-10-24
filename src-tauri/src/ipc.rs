//! 前端唯一能呼叫的指令。先確認呼叫者可信，再原樣轉給核心；
//! 取代 Electron 版的 isTrustedSender，通道與參數的驗證留在核心（src/main/ipc-validation.ts）。

use serde_json::Value;
use tauri::{Manager, State, Url, Webview};

use crate::protocol::WireError;
use crate::supervisor::SidecarHandle;

const MAIN_WINDOW_LABEL: &str = "main";
const MAX_CHANNEL_LEN: usize = 64;

/// 通道名只允許小寫英數、冒號與連字號，例如 `launcher:mappings:list`。
pub fn is_valid_channel(channel: &str) -> bool {
    !channel.is_empty()
        && channel.len() <= MAX_CHANNEL_LEN
        && channel.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == ':' || c == '-')
}

/// 打包版頁面來自 `tauri://localhost`；開發時只信任設定的 dev server 來源（同協定、主機、port）。
pub fn is_trusted_origin(url: &Url, dev: Option<&Url>) -> bool {
    if url.scheme() == "tauri" && url.host_str() == Some("localhost") {
        return true;
    }
    match dev {
        Some(dev) => {
            url.scheme() == dev.scheme()
                && url.host_str() == dev.host_str()
                && url.port_or_known_default() == dev.port_or_known_default()
        }
        None => false,
    }
}

/// 開發用來源只在 debug 建置有效，正式版不會因為設定檔裡殘留的網址而多信任一個來源。
pub fn dev_origin(app: &tauri::AppHandle) -> Option<Url> {
    if cfg!(debug_assertions) {
        app.config().build.dev_url.clone()
    } else {
        None
    }
}

#[tauri::command]
pub async fn ipc_invoke(
    webview: Webview,
    sidecar: State<'_, SidecarHandle>,
    channel: String,
    args: Vec<Value>,
) -> Result<Value, WireError> {
    if webview.label() != MAIN_WINDOW_LABEL {
        return Err(WireError::new("Error", "ipc: untrusted sender"));
    }
    let dev = dev_origin(webview.app_handle());
    match webview.url() {
        Ok(url) if is_trusted_origin(&url, dev.as_ref()) => {}
        _ => return Err(WireError::new("Error", "ipc: untrusted sender")),
    }
    if !is_valid_channel(&channel) {
        return Err(WireError::new("Error", "ipc: invalid channel"));
    }
    // 視窗顯示由外殼自己處理，核心不需要知道。
    if channel == crate::window::READY_CHANNEL {
        crate::window::reveal_main_window(webview.app_handle());
        return Ok(Value::Null);
    }
    sidecar.invoke(&channel, args).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    #[test]
    fn accepts_real_channel_names_and_rejects_everything_else() {
        for channel in ["app:info", "launcher:mappings:list", "backups:delete-all", "run:scan-ports"] {
            assert!(is_valid_channel(channel), "{channel}");
        }
        for channel in ["", "App:info", "app info", "app:info\n", "a/b", "../x", &"a".repeat(65)] {
            assert!(!is_valid_channel(channel), "{channel:?}");
        }
    }

    #[test]
    fn trusts_the_packaged_origin_only_without_a_dev_url() {
        assert!(is_trusted_origin(&url("tauri://localhost/index.html"), None));
        assert!(!is_trusted_origin(&url("http://localhost:5175/"), None));
        assert!(!is_trusted_origin(&url("https://evil.example/"), None));
        assert!(!is_trusted_origin(&url("tauri://evil/"), None));
    }

    #[test]
    fn trusts_the_dev_server_origin_exactly() {
        let dev = url("http://localhost:5175/");
        assert!(is_trusted_origin(&url("http://localhost:5175/index.html"), Some(&dev)));
        assert!(!is_trusted_origin(&url("http://localhost:5176/"), Some(&dev)));
        assert!(!is_trusted_origin(&url("https://localhost:5175/"), Some(&dev)));
        assert!(!is_trusted_origin(&url("http://127.0.0.1:5175/"), Some(&dev)));
    }
}
