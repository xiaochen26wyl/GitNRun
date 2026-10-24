use std::{sync::Arc, time::Duration};

use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

use super::failure;
use crate::protocol::Reply;

#[derive(Deserialize)]
pub struct WriteParams {
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteExpiringParams {
    text: String,
    ttl_ms: u64,
}

/// 剪貼簿的最小介面；到期邏輯只依賴它，所以可以用假的實作測試。
pub trait ClipboardOps: Send + Sync + 'static {
    fn read(&self) -> Option<String>;
    fn clear(&self);
}

struct AppClipboard(AppHandle);

impl ClipboardOps for AppClipboard {
    fn read(&self) -> Option<String> {
        self.0.clipboard().read_text().ok()
    }

    fn clear(&self) {
        let _ = self.0.clipboard().clear();
    }
}

/// 到期時只在內容仍是 text 的情況下清掉，不會誤刪使用者後來複製的東西。
/// 計時器放在 Rust：核心（sidecar）重啟不影響已排定的清除。
pub async fn clear_if_unchanged(ops: Arc<dyn ClipboardOps>, text: String, ttl: Duration) {
    tokio::time::sleep(ttl).await;
    if ops.read().as_deref() == Some(text.as_str()) {
        ops.clear();
    }
}

pub fn write(app: &AppHandle, params: WriteParams) -> Reply {
    app.clipboard().write_text(params.text).map_err(failure)?;
    Ok(None)
}

pub fn write_expiring(app: &AppHandle, params: WriteExpiringParams) -> Reply {
    app.clipboard().write_text(params.text.clone()).map_err(failure)?;
    let ops: Arc<dyn ClipboardOps> = Arc::new(AppClipboard(app.clone()));
    tauri::async_runtime::spawn(clear_if_unchanged(ops, params.text, Duration::from_millis(params.ttl_ms)));
    Ok(None)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    struct Fake {
        content: Mutex<Option<String>>,
    }

    impl ClipboardOps for Fake {
        fn read(&self) -> Option<String> {
            self.content.lock().unwrap().clone()
        }

        fn clear(&self) {
            *self.content.lock().unwrap() = None;
        }
    }

    fn fake(content: &str) -> Arc<Fake> {
        Arc::new(Fake { content: Mutex::new(Some(content.to_string())) })
    }

    #[tokio::test(start_paused = true)]
    async fn clears_the_secret_when_it_is_still_there_at_expiry() {
        let clipboard = fake("s3cret");
        clear_if_unchanged(clipboard.clone(), "s3cret".into(), Duration::from_secs(60)).await;
        assert_eq!(clipboard.read(), None);
    }

    #[tokio::test(start_paused = true)]
    async fn leaves_something_the_user_copied_afterwards() {
        let clipboard = fake("s3cret");
        let task = tokio::spawn(clear_if_unchanged(clipboard.clone(), "s3cret".into(), Duration::from_secs(60)));
        tokio::time::sleep(Duration::from_secs(10)).await;
        *clipboard.content.lock().unwrap() = Some("my own text".into());
        task.await.unwrap();
        assert_eq!(clipboard.read().as_deref(), Some("my own text"));
    }
}
