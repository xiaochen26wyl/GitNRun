//! 核心向外殼要求的原生能力。方法名稱與 src/main/sidecar/protocol.ts 的 NATIVE 一一對應；
//! 負載只經過連線，不寫進日誌。尚未實作的能力回覆明確的錯誤，核心端視為該能力不可用。

mod clipboard;
mod confirm;
mod dialogs;
mod keychain;
mod mac;
mod menu_popup;
mod notify;
mod shortcut;

use serde::de::DeserializeOwned;
use serde_json::Value;
use tauri::AppHandle;

use crate::protocol::{Reply, WireError};
use crate::supervisor::{CancelToken, SidecarHandle};

/// 一次原生請求的上下文；cancel 在核心送來取消事件（例如確認框逾時）時觸發。
pub struct Ctx {
    pub app: AppHandle,
    pub cancel: CancelToken,
}

pub(crate) fn parse<T: DeserializeOwned>(params: Option<Value>) -> Result<T, WireError> {
    serde_json::from_value(params.unwrap_or(Value::Null)).map_err(|_| WireError::new("InvalidParams", "invalid native request parameters"))
}

pub(crate) fn failure(error: impl ToString) -> WireError {
    WireError::new("NativeError", error.to_string())
}

/// 開發版的 Dock 圖示會是預設圖示，改成專案 logo；打包版由 bundle 的圖示負責。
pub fn set_dev_dock_icon() {
    if cfg!(debug_assertions) {
        mac::set_dock_icon(concat!(env!("CARGO_MANIFEST_DIR"), "/../build/icon.png"));
    }
}

pub async fn handle(ctx: Ctx, sidecar: SidecarHandle, method: &str, params: Option<Value>) -> Reply {
    match method {
        "native.window.focus" => {
            let app = ctx.app.clone();
            ctx.app.run_on_main_thread(move || crate::window::show_main_window(&app)).map_err(failure)?;
            Ok(None)
        }
        "native.clipboard.write" => clipboard::write(&ctx.app, parse(params)?),
        "native.clipboard.writeExpiring" => clipboard::write_expiring(&ctx.app, parse(params)?),
        "native.dialog.confirm" => confirm::show(&ctx, parse(params)?).await,
        "native.openExternal" => dialogs::open_external(&ctx.app, parse(params)?),
        "native.dialog.open" => dialogs::open_file(&ctx.app, parse(params)?).await,
        "native.dialog.save" => dialogs::save_file(&ctx.app, parse(params)?).await,
        "native.errorBox" => dialogs::error_box(&ctx.app, parse(params)?).await,
        "native.notify" => notify::show(&ctx.app, parse(params)?),
        "native.keychain.masterKey" => keychain::master_key().await,
        "native.shortcut.register" => shortcut::register(&ctx, sidecar, parse(params)?),
        "native.shortcut.unregister" => shortcut::unregister(&ctx.app, parse(params)?),
        "native.shortcut.unregisterAll" => shortcut::unregister_all(&ctx.app),
        "native.menu.popup" => menu_popup::popup(&ctx.app, sidecar, parse(params)?),
        "native.dock.bounce" => mac::bounce_dock(&ctx.app),
        other => Err(WireError::new("NativeUnsupported", format!("{other} is not implemented yet"))),
    }
}
