// 打包版不要跟著開一個終端機視窗。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    gitnrun_lib::run();
}
