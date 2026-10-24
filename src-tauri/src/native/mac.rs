//! macOS 專屬的原生呼叫（AppKit）。

use tauri::AppHandle;

use super::confirm::ConfirmParams;
use super::failure;
use crate::protocol::Reply;

/// NSModalResponseAbort。
pub const MODAL_ABORTED: isize = -1001;

#[cfg(target_os = "macos")]
pub fn bounce_dock(app: &AppHandle) -> Reply {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSRequestUserAttentionType};

    app.run_on_main_thread(|| {
        if let Some(mtm) = MainThreadMarker::new() {
            NSApplication::sharedApplication(mtm).requestUserAttention(NSRequestUserAttentionType::CriticalRequest);
        }
    })
    .map_err(failure)?;
    Ok(None)
}

/// 顯示 NSAlert 並等使用者按下按鈕；必須在主執行緒呼叫。回傳 NSModalResponse。
#[cfg(target_os = "macos")]
pub fn run_alert(params: &ConfirmParams) -> isize {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSAlert, NSAlertStyle};
    use objc2_foundation::NSString;

    let Some(mtm) = MainThreadMarker::new() else { return MODAL_ABORTED };
    let alert = NSAlert::new(mtm);
    alert.setAlertStyle(if params.kind == "warning" { NSAlertStyle::Warning } else { NSAlertStyle::Informational });
    alert.setMessageText(&NSString::from_str(&params.message));
    alert.setInformativeText(&NSString::from_str(&params.detail));
    for title in &params.buttons {
        alert.addButtonWithTitle(&NSString::from_str(title));
    }
    // Electron 的 defaultId 對應 Return 鍵、cancelId 對應 Esc 鍵。
    for (index, button) in alert.buttons().iter().enumerate() {
        let key = if index == params.default_id {
            "\r"
        } else if index == params.cancel_id {
            "\u{1b}"
        } else {
            ""
        };
        button.setKeyEquivalent(&NSString::from_str(key));
    }
    alert.runModal()
}

/// 從任何執行緒結束目前的 modal。用 GCD 主佇列送，因為 modal 進行中 Tauri 的主執行緒佇列不會被處理。
#[cfg(target_os = "macos")]
pub fn abort_modal() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;

    dispatch2::DispatchQueue::main().exec_async(|| {
        if let Some(mtm) = MainThreadMarker::new() {
            NSApplication::sharedApplication(mtm).abortModal();
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub fn bounce_dock(_app: &AppHandle) -> Reply {
    Ok(None)
}

#[cfg(not(target_os = "macos"))]
pub fn run_alert(_params: &ConfirmParams) -> isize {
    MODAL_ABORTED
}

#[cfg(not(target_os = "macos"))]
pub fn abort_modal() {}

/// 以圖檔設定 Dock 圖示（檔案不存在就略過）。
#[cfg(target_os = "macos")]
pub fn set_dock_icon(path: &'static str) {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSString;

    let Some(mtm) = MainThreadMarker::new() else { return };
    if !std::path::Path::new(path).exists() {
        return;
    }
    if let Some(image) = NSImage::initWithContentsOfFile(NSImage::alloc(), &NSString::from_str(path)) {
        unsafe { NSApplication::sharedApplication(mtm).setApplicationIconImage(Some(&image)) };
    }
}

#[cfg(not(target_os = "macos"))]
pub fn set_dock_icon(_path: &'static str) {}
