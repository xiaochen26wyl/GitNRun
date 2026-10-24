//! 全域快捷鍵。核心用 Electron 的 accelerator 寫法，Tauri 的解析器有幾處不同，
//! 所以先正規化再解析；已知對不上的寫法註冊會失敗，走核心既有的「註冊失敗」顯示。
//! 接受／拒絕的清單與 TypeScript 驗證器共用 tests/fixtures/accelerators.json。

use std::str::FromStr;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use super::Ctx;
use crate::protocol::Reply;
use crate::supervisor::SidecarHandle;

#[derive(Deserialize)]
pub struct AcceleratorParams {
    accelerator: String,
}

/// 需要按住 Shift 才能打出的符號：Tauri 的解析器不認得（它要的是實體按鍵）。
const SHIFT_SYMBOLS: &str = "!@#$%^&*()_+{}:\"<>?|~";

/// 把 Electron 的寫法轉成 Tauri 解析器接受的寫法；對不上時回傳 None。
/// 規則：meta → super、altgr → alt、Return → Enter；重複的修飾鍵、"+" 當主鍵與 Shift 符號不支援。
pub fn normalize(accelerator: &str) -> Option<String> {
    // Tauri 的解析器會悄悄修剪空白，Electron 不會；空白一律當作格式錯誤。
    if accelerator.is_empty() || accelerator.len() > 60 || accelerator.ends_with("++") || accelerator.chars().any(char::is_whitespace) {
        return None;
    }
    let mut parts: Vec<&str> = accelerator.split('+').collect();
    let key = parts.pop()?;
    if parts.is_empty() || key.is_empty() {
        return None;
    }
    if key.chars().count() == 1 && key.chars().all(|c| SHIFT_SYMBOLS.contains(c)) {
        return None;
    }

    // 修飾鍵不可重複（與 TypeScript 驗證器一致；Tauri 的解析器自己不擋）。
    let lowered: Vec<String> = parts.iter().map(|modifier| modifier.to_ascii_lowercase()).collect();
    if lowered.iter().enumerate().any(|(index, name)| lowered[..index].contains(name)) {
        return None;
    }

    let mut out: Vec<String> = Vec::with_capacity(parts.len() + 1);
    for modifier in parts {
        out.push(match modifier.to_ascii_lowercase().as_str() {
            "meta" => "super".to_string(),
            "altgr" => "alt".to_string(),
            _ => modifier.to_string(),
        });
    }
    out.push(if key.eq_ignore_ascii_case("return") { "Enter".to_string() } else { key.to_string() });
    Some(out.join("+"))
}

pub fn parse(accelerator: &str) -> Option<Shortcut> {
    Shortcut::from_str(&normalize(accelerator)?).ok()
}

/// 註冊成功回傳 true；格式不被接受、已被其他程式占用都回傳 false。
pub fn register(ctx: &Ctx, sidecar: SidecarHandle, params: AcceleratorParams) -> Reply {
    let Some(shortcut) = parse(&params.accelerator) else { return Ok(Some(json!(false))) };
    let accelerator = params.accelerator;
    let result = ctx.app.global_shortcut().on_shortcut(shortcut, move |_app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            // 以核心註冊時的原字串回報，核心用它找回對應的處理函式。
            sidecar.send_event("shortcut", Some(json!({ "accelerator": accelerator })));
        }
    });
    Ok(Some(Value::Bool(result.is_ok())))
}

pub fn unregister(app: &AppHandle, params: AcceleratorParams) -> Reply {
    if let Some(shortcut) = parse(&params.accelerator) {
        let _ = app.global_shortcut().unregister(shortcut);
    }
    Ok(None)
}

pub fn unregister_all(app: &AppHandle) -> Reply {
    let _ = app.global_shortcut().unregister_all();
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct Entry {
        accelerator: String,
        valid: bool,
        rust: String,
    }

    fn entries() -> Vec<Entry> {
        serde_json::from_str(include_str!("../../../tests/fixtures/accelerators.json")).expect("fixture parses")
    }

    #[test]
    fn follows_the_shared_fixture_exactly() {
        for entry in entries() {
            let accepted = parse(&entry.accelerator).is_some();
            match entry.rust.as_str() {
                "ok" => assert!(accepted && entry.valid, "{:?} should be accepted", entry.accelerator),
                // TypeScript 接受、Rust 做不到：註冊會失敗。
                "unsupported" => assert!(!accepted && entry.valid, "{:?} is a known gap", entry.accelerator),
                _ => assert!(!accepted && !entry.valid, "{:?} should be rejected", entry.accelerator),
            }
        }
    }

    #[test]
    fn rewrites_the_spellings_the_parser_does_not_know() {
        assert_eq!(normalize("Cmd+Shift+Return").as_deref(), Some("Cmd+Shift+Enter"));
        assert_eq!(normalize("Meta+T").as_deref(), Some("super+T"));
        assert_eq!(normalize("AltGr+T").as_deref(), Some("alt+T"));
        assert_eq!(normalize("CommandOrControl+Shift+T").as_deref(), Some("CommandOrControl+Shift+T"));
    }

    #[test]
    fn refuses_shifted_symbols_and_plus_as_the_main_key() {
        for accelerator in ["Cmd+!", "Cmd+(", "Shift++", "Cmd+Shift++", "Cmd+~"] {
            assert_eq!(normalize(accelerator), None, "{accelerator}");
        }
        // 不需要 Shift 的標點照常通過。
        for accelerator in ["Cmd+/", "Cmd+,", "Cmd+-", "Cmd+=", "Cmd+["] {
            assert!(normalize(accelerator).is_some(), "{accelerator}");
        }
    }

    #[test]
    fn the_default_shortcut_parses() {
        assert!(parse("CommandOrControl+Shift+T").is_some());
    }
}
