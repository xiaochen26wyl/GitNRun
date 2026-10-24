use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

use super::failure;
use crate::protocol::Reply;
use crate::window::MAIN_LABEL;

#[derive(Deserialize)]
pub struct Filter {
    name: String,
    extensions: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveParams {
    title: String,
    default_path: String,
    filters: Vec<Filter>,
}

#[derive(Deserialize)]
pub struct OpenParams {
    title: String,
    filters: Vec<Filter>,
}

#[derive(Deserialize)]
pub struct ErrorBoxParams {
    title: String,
    content: String,
}

#[derive(Deserialize)]
pub struct OpenExternalParams {
    url: String,
}

/// 預設路徑拆成資料夾與檔名（對話框要分開給）。
pub fn split_default_path(default_path: &str) -> (Option<PathBuf>, Option<String>) {
    let path = Path::new(default_path);
    let file = path.file_name().map(|name| name.to_string_lossy().into_owned());
    let dir = path.parent().filter(|parent| !parent.as_os_str().is_empty()).map(Path::to_path_buf);
    (dir, file)
}

fn with_filters(mut builder: FileDialogBuilder<tauri::Wry>, filters: &[Filter]) -> FileDialogBuilder<tauri::Wry> {
    for filter in filters {
        let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
        builder = builder.add_filter(&filter.name, &extensions);
    }
    builder
}

/// 與 Electron 一致：有主視窗就掛成它的 sheet。
fn with_parent(app: &AppHandle, builder: FileDialogBuilder<tauri::Wry>) -> FileDialogBuilder<tauri::Wry> {
    match app.get_webview_window(MAIN_LABEL) {
        Some(window) => builder.set_parent(&window),
        None => builder,
    }
}

pub async fn open_file(app: &AppHandle, params: OpenParams) -> Reply {
    let app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let builder = with_parent(&app, with_filters(app.dialog().file().set_title(params.title), &params.filters));
        builder.blocking_pick_file()
    })
    .await
    .map_err(failure)?;
    Ok(Some(match picked.and_then(|file| file.into_path().ok()) {
        Some(path) => json!({ "canceled": false, "filePaths": [path] }),
        None => json!({ "canceled": true, "filePaths": [] }),
    }))
}

pub async fn save_file(app: &AppHandle, params: SaveParams) -> Reply {
    let app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let (dir, file) = split_default_path(&params.default_path);
        let mut builder = with_filters(app.dialog().file().set_title(params.title), &params.filters);
        if let Some(dir) = dir {
            builder = builder.set_directory(dir);
        }
        if let Some(file) = file {
            builder = builder.set_file_name(file);
        }
        with_parent(&app, builder).blocking_save_file()
    })
    .await
    .map_err(failure)?;
    Ok(Some(match picked.and_then(|file| file.into_path().ok()) {
        Some(path) => json!({ "canceled": false, "filePath": path }),
        None => json!({ "canceled": true }),
    }))
}

pub async fn error_box(app: &AppHandle, params: ErrorBoxParams) -> Reply {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog().message(params.content).title(params.title).kind(MessageDialogKind::Error).blocking_show();
    })
    .await
    .map_err(failure)?;
    Ok(None)
}

pub fn open_external(app: &AppHandle, params: OpenExternalParams) -> Reply {
    app.opener().open_url(params.url, None::<&str>).map_err(failure)?;
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_a_default_path_into_folder_and_file_name() {
        assert_eq!(
            split_default_path("/Users/me/Documents/gitnrun-rules.json"),
            (Some(PathBuf::from("/Users/me/Documents")), Some("gitnrun-rules.json".to_string()))
        );
        assert_eq!(split_default_path("rules.json"), (None, Some("rules.json".to_string())));
        assert_eq!(split_default_path(""), (None, None));
    }
}
