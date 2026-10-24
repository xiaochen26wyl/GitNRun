fn main() {
    // 前端只能呼叫這一個指令；其餘 app 指令一律不開放（capabilities 只授權它）。
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["ipc_invoke"])),
    )
    .expect("failed to run tauri-build");
}
