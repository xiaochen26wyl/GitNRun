use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

use super::failure;
use crate::protocol::Reply;

#[derive(Deserialize)]
pub struct NotifyParams {
    title: String,
    body: String,
    /// 0 代表核心沒有要等點擊；其餘由核心編號，點擊時用同一個編號回報。
    id: i32,
}

pub fn show(app: &AppHandle, params: NotifyParams) -> Reply {
    let mut builder = app.notification().builder().title(params.title).body(params.body);
    if params.id > 0 {
        builder = builder.id(params.id);
    }
    builder.show().map_err(failure)?;
    Ok(None)
}
