//! 主視窗：由 Rust 建立並先隱藏，前端外殼首次繪製後才顯示（避免白畫面閃一下）。
//! 關閉視窗只隱藏，WebView 與前端狀態都留著，再次打開不必冷啟動。

use std::time::Duration;

use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::ipc::{dev_origin, is_trusted_origin};

pub const MAIN_LABEL: &str = "main";
/// 寬度比原本的 1100 / 820 各多 5rem（80px）；高度不寫死，預設取主螢幕高度的 70%（70vh）。
/// 實測：Tauri 在 macOS 把高度當成含標題列的外框。
const WIDTH: f64 = 1180.0;
const MIN_WIDTH: f64 = 900.0;
const MIN_HEIGHT: f64 = 520.0;
/// 讀不到螢幕資訊時的預設高度。
const FALLBACK_HEIGHT: f64 = 720.0;
const HEIGHT_RATIO: f64 = 0.7;
/// Electron 實測的標題是頁面 <title>；Tauri 不會跟著 document.title，所以明確指定。
const TITLE: &str = "GitNRun";
/// 前端外殼繪製完成後經 ipc_invoke 送來的通道；Rust 自己處理，不轉給核心。
pub const READY_CHANNEL: &str = "window:ready";
/// 前端一直沒回報（出錯或核心遲遲未就緒）時的後備：逾時仍顯示視窗，不讓它永遠不出現。
const SHOW_FALLBACK: Duration = Duration::from_secs(2);

/// 關閉請求要改成隱藏的視窗：只有主視窗。
pub fn hides_instead_of_closing(label: &str) -> bool {
    label == MAIN_LABEL
}

/// 導航白名單：只能停在本 app 的頁面（取代 Electron 的 will-navigate 封鎖）。
pub fn is_navigation_allowed(url: &Url, dev: Option<&Url>) -> bool {
    is_trusted_origin(url, dev)
}

/// 預設視窗高度：螢幕邏輯高度的 70%，不低於最小高度、不超過螢幕；沒有螢幕資訊就用後備值。
pub fn default_height(screen_height: Option<f64>) -> f64 {
    match screen_height {
        Some(screen) if screen.is_finite() && screen > 0.0 => (screen * HEIGHT_RATIO).max(MIN_HEIGHT).min(screen),
        _ => FALLBACK_HEIGHT,
    }
}

fn screen_height(app: &AppHandle) -> Option<f64> {
    let monitor = app.primary_monitor().ok().flatten()?;
    Some(monitor.size().height as f64 / monitor.scale_factor())
}

pub fn create_main_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let dev = dev_origin(app);
    let height = default_height(screen_height(app));
    let window = WebviewWindowBuilder::new(app, MAIN_LABEL, WebviewUrl::App("index.html".into()))
        .title(TITLE)
        .inner_size(WIDTH, height)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .visible(false)
        // 拖放檔案進視窗不處理（shim 也已攔截），避免整頁被導向檔案。
        .disable_drag_drop_handler()
        .on_navigation(move |url| is_navigation_allowed(url, dev.as_ref()))
        .build()?;
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SHOW_FALLBACK).await;
        reveal_main_window(&handle);
    });
    Ok(window)
}

/// 前端回報外殼已繪製（或逾時後備）：顯示主視窗。已經顯示就不動，避免搶走焦點。
pub fn reveal_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        if !window.is_visible().unwrap_or(false) {
            let _ = window.show();
        }
    }
}

/// 聚焦主視窗；已被關閉（只是銷毀畫面，app 仍在背景）就重建。
pub fn show_main_window(app: &AppHandle) {
    let window = match app.get_webview_window(MAIN_LABEL) {
        Some(window) => Some(window),
        None => create_main_window(app).ok(),
    };
    if let Some(window) = window {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_main_window_is_hidden_on_close() {
        assert!(hides_instead_of_closing(MAIN_LABEL));
        assert!(!hides_instead_of_closing("other"));
    }

    #[test]
    fn default_height_is_seventy_percent_of_the_screen_within_limits() {
        assert_eq!(default_height(Some(1000.0)), 700.0);
        assert_eq!(default_height(Some(600.0)), MIN_HEIGHT);
        assert_eq!(default_height(Some(400.0)), 400.0);
        assert_eq!(default_height(None), FALLBACK_HEIGHT);
        assert_eq!(default_height(Some(f64::NAN)), FALLBACK_HEIGHT);
    }

    #[test]
    fn only_the_apps_own_pages_may_be_navigated_to() {
        let dev = Url::parse("http://localhost:5175/").unwrap();
        assert!(is_navigation_allowed(&Url::parse("tauri://localhost/").unwrap(), None));
        assert!(is_navigation_allowed(&Url::parse("http://localhost:5175/x").unwrap(), Some(&dev)));
        assert!(!is_navigation_allowed(&Url::parse("https://github.com/").unwrap(), Some(&dev)));
        assert!(!is_navigation_allowed(&Url::parse("file:///etc/passwd").unwrap(), None));
    }
}
