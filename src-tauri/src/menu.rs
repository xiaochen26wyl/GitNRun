//! 應用程式選單，鏡射 Electron 的預設選單：Edit 讓 ⌘C／⌘V 生效，View 提供重載、縮放、開發者工具。

use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Manager, Wry,
};

const ZOOM_STEP: f64 = 1.2;
const ZOOM_MIN: f64 = 0.5;
const ZOOM_MAX: f64 = 3.0;

/// 目前的頁面縮放倍率（跨重載保留在記憶體，重新啟動 app 後回到 1）。
pub struct ZoomState(pub Mutex<f64>);

impl Default for ZoomState {
    fn default() -> Self {
        ZoomState(Mutex::new(1.0))
    }
}

pub fn next_zoom(current: f64, action: &str) -> f64 {
    match action {
        "zoom_in" => (current * ZOOM_STEP).min(ZOOM_MAX),
        "zoom_out" => (current / ZOOM_STEP).max(ZOOM_MIN),
        _ => 1.0,
    }
}

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let app_menu = Submenu::with_items(
        app,
        "GitNRun",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?,
            &MenuItem::with_id(app, "force_reload", "Force Reload", true, Some("Shift+CmdOrCtrl+R"))?,
            &MenuItem::with_id(app, "devtools", "Toggle Developer Tools", true, Some("Alt+CmdOrCtrl+I"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "zoom_reset", "Actual Size", true, Some("CmdOrCtrl+0"))?,
            &MenuItem::with_id(app, "zoom_in", "Zoom In", true, Some("CmdOrCtrl+="))?,
            &MenuItem::with_id(app, "zoom_out", "Zoom Out", true, Some("CmdOrCtrl+-"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &edit_menu, &view_menu, &window_menu])
}

pub fn on_event(app: &AppHandle, event: MenuEvent) {
    let Some(window) = app.get_webview_window(crate::window::MAIN_LABEL) else { return };
    match event.id().as_ref() {
        // Tauri 沒有略過快取的重載，兩者行為相同。
        "reload" | "force_reload" => {
            let _ = window.eval("window.location.reload()");
        }
        "devtools" => {
            if window.is_devtools_open() {
                window.close_devtools();
            } else {
                window.open_devtools();
            }
        }
        action @ ("zoom_in" | "zoom_out" | "zoom_reset") => {
            let state = app.state::<ZoomState>();
            let mut zoom = state.0.lock().expect("zoom lock");
            *zoom = next_zoom(*zoom, action);
            let _ = window.set_zoom(*zoom);
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zoom_steps_are_clamped_and_reset_returns_to_one() {
        assert!((next_zoom(1.0, "zoom_in") - 1.2).abs() < 1e-9);
        assert!((next_zoom(1.0, "zoom_out") - 1.0 / 1.2).abs() < 1e-9);
        assert_eq!(next_zoom(2.9, "zoom_in"), 3.0);
        assert_eq!(next_zoom(0.51, "zoom_out"), 0.5);
        assert_eq!(next_zoom(2.0, "zoom_reset"), 1.0);
    }
}
