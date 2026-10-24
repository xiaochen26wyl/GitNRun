mod external;
mod ipc;
mod launch;
mod menu;
mod native;
mod protocol;
mod supervisor;
mod window;

use std::{path::PathBuf, sync::Mutex, time::{Duration, Instant}};

use supervisor::{HostInfo, RestartBudget, SidecarConfig, SidecarHandle};
use tauri::{Manager, RunEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;

const ENV_SOCKET: &str = "GITNRUN_SIDECAR_SOCKET";
const ENV_TOKEN: &str = "GITNRUN_SIDECAR_TOKEN";

/// 沿用 Electron 時代的資料夾，不搬資料（Tauri 預設的 com.gitnrun.app 目錄不採用）。
fn data_dir() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    home.join("Library").join("Application Support").join("GitNRun")
}

/// 開發時 sidecar 由 scripts/dev.ts 啟動，連線資訊經環境變數交付；
/// 讀完立刻移除，避免被這個行程之後啟動的任何子行程繼承。
fn take_sidecar_config(app: &tauri::AppHandle) -> Option<SidecarConfig> {
    let socket = std::env::var_os(ENV_SOCKET);
    let token = std::env::var(ENV_TOKEN).ok();
    std::env::remove_var(ENV_SOCKET);
    std::env::remove_var(ENV_TOKEN);
    let (socket, token) = (socket?, token?);
    Some(SidecarConfig {
        socket_path: PathBuf::from(socket),
        token,
        host: HostInfo {
            app_name: "GitNRun".to_string(),
            app_version: app.package_info().version.to_string(),
            data_dir: data_dir(),
            packaged: !cfg!(debug_assertions),
        },
    })
}

/// 渲染程序（WebContent）被終止時自動重載；60 秒內超過 3 次就停下來並告知使用者，避免無限重載。
const RELOAD_MAX: usize = 3;
const RELOAD_WINDOW: Duration = Duration::from_secs(60);

/// 正式版：產生連線憑證，由 Rust 啟動內附 Node 執行核心；回傳給監督器用的連線設定。
fn start_bundled_core(app: &tauri::AppHandle) -> Result<SidecarConfig, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    let (node, script) = launch::sidecar_paths(&exe, &resources).ok_or("cannot locate the bundled core")?;
    let uid = std::env::var_os("HOME")
        .and_then(|home| std::fs::metadata(home).ok())
        .map(|meta| std::os::unix::fs::MetadataExt::uid(&meta))
        .unwrap_or(0);
    let token = launch::random_token()?;
    let socket = launch::socket_path(&std::env::temp_dir(), uid);
    let data = data_dir();

    let error_app = app.clone();
    let launcher = launch::Launcher::start(
        launch::LaunchConfig::bundled(node, script, socket.clone(), token.clone(), data.join("sidecar.log")),
        move |message| {
            error_app.dialog().message(message).title("GitNRun").kind(MessageDialogKind::Error).show(|_| {});
        },
    );
    app.manage(launcher);

    Ok(SidecarConfig {
        socket_path: socket,
        token,
        host: HostInfo {
            app_name: "GitNRun".to_string(),
            app_version: app.package_info().version.to_string(),
            data_dir: data,
            packaged: true,
        },
    })
}

pub fn run() {
    let reload_budget = Mutex::new(RestartBudget::new(RELOAD_MAX, RELOAD_WINDOW));
    let app = tauri::Builder::default()
        .on_web_content_process_terminate(move |webview| {
            let allowed = reload_budget.lock().map(|mut budget| budget.try_record(Instant::now())).unwrap_or(false);
            if allowed {
                let _ = webview.reload();
            } else {
                webview
                    .app_handle()
                    .dialog()
                    .message("畫面程序在短時間內多次異常結束，已停止自動重新載入。請用選單 View → Reload，或重新開啟 GitNRun。")
                    .title("GitNRun")
                    .kind(MessageDialogKind::Error)
                    .show(|_| {});
            }
        })
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            window::show_main_window(app);
            if let Some(sidecar) = app.try_state::<SidecarHandle>() {
                sidecar.send_event("second-instance", None);
            }
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        // 前端的 <a target=_blank> 不自動開啟：Electron 現行也是點了沒反應，先保持相同。
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .menu(menu::build)
        .on_menu_event(menu::on_event)
        .manage(menu::ZoomState::default())
        .manage(SidecarHandle::new())
        .invoke_handler(tauri::generate_handler![ipc::ipc_invoke])
        .setup(|app| {
            let handle = app.handle();
            let config = match take_sidecar_config(handle) {
                Some(config) => Some(config),
                // 打包版沒有 dev 腳本替我們啟動核心，自己啟動。
                None if !cfg!(debug_assertions) => Some(start_bundled_core(handle)?),
                None => None,
            };
            match config {
                Some(config) => {
                    let sidecar = app.state::<SidecarHandle>().inner().clone();
                    tauri::async_runtime::spawn(supervisor::supervise(handle.clone(), sidecar, config));
                }
                None => eprintln!(
                    "[gitnrun] {ENV_SOCKET} / {ENV_TOKEN} are not set; start the app with `pnpm dev:tauri` so the core is available"
                ),
            }
            // 通知被點擊時回報核心（核心再聚焦主視窗）；點擊事件由通知外掛從系統回報。
            let click_sidecar = app.state::<SidecarHandle>().inner().clone();
            app.notification().on_action(move |performed| {
                if performed.action_id() != "tap" {
                    return;
                }
                if let Some(notification) = performed.notification() {
                    click_sidecar.send_event("notification-click", Some(serde_json::json!({ "id": notification.id() })));
                }
            })?;
            native::set_dev_dock_icon();
            window::create_main_window(handle)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Tauri application");

    app.run(|handle, event| match event {
        // 關閉視窗只是銷毀畫面，app 與快捷鍵留在背景；要結束請用 ⌘Q（那時 code 是 Some）。
        RunEvent::ExitRequested { api, code, .. } if code.is_none() => api.prevent_exit(),
        // Finder／網址／Dock 交給 app 開啟的項目（冷啟動時比 setup 還早到）。
        RunEvent::Opened { urls } => {
            if let Some(sidecar) = handle.try_state::<SidecarHandle>() {
                for request in urls.iter().filter_map(external::to_request) {
                    sidecar.open_external(request);
                }
            }
        }
        // 點 Dock 圖示且沒有視窗時重建。
        RunEvent::Reopen { has_visible_windows, .. } if !has_visible_windows => window::show_main_window(handle),
        // 結束時請核心乾淨關閉資料庫。開發版不送：Rust 重編重啟也會走到這裡，不能把存活的 sidecar 關掉。
        #[cfg(not(debug_assertions))]
        RunEvent::Exit => {
            if let Some(sidecar) = handle.try_state::<SidecarHandle>() {
                sidecar.send_event("app.quit", None);
                // 等核心自己收尾（關資料庫、放掉鎖），逾時才強制結束。
                if let Some(launcher) = handle.try_state::<launch::Launcher>() {
                    tauri::async_runtime::block_on(launcher.shutdown(std::time::Duration::from_secs(5)));
                }
            }
        }
        _ => {}
    });
}
