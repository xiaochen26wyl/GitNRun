//! 保險庫主金鑰：32 位元組隨機值，以 base64 存在 macOS Keychain，核心啟動時向外殼取得。
//! 金鑰只回給核心（經 unix socket），不落地、不記錄。
//!
//! 開發版與正式版共用同一個項目。重新編譯後二進位的簽章雜湊會改變，macOS 會再次要求授權；
//! 授權提示沒有回應時，逾時後回報錯誤，核心會讓保險庫保持鎖定（不能存取密鑰），而不是卡住啟動。

use std::{sync::Mutex, time::Duration};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;

use crate::protocol::{Reply, WireError};

const SERVICE: &str = "com.gitnrun.app";
const ACCOUNT: &str = "vault-master-key";
pub const KEY_BYTES: usize = 32;
/// 留時間給使用者點授權提示。
const PROMPT_TIMEOUT: Duration = Duration::from_secs(90);

/// Keychain 的最小介面，讓取得或建立金鑰的邏輯可以用假的實作測試。
pub trait KeyStore: Send + Sync + 'static {
    fn get(&self) -> Result<Option<String>, String>;
    fn set(&self, value: &str) -> Result<(), String>;
}

/// 取得已存在的金鑰；沒有才產生並存入。已存在但格式不對（被改動或損毀）時回報錯誤，
/// 不覆寫：覆寫會讓既有密文永遠解不開，卻看起來一切正常。
pub fn get_or_create_key(store: &dyn KeyStore, fill: impl Fn(&mut [u8]) -> Result<(), String>) -> Result<String, String> {
    if let Some(existing) = store.get()? {
        let valid = STANDARD.decode(existing.trim()).map(|bytes| bytes.len() == KEY_BYTES).unwrap_or(false);
        return if valid { Ok(existing.trim().to_string()) } else { Err("stored master key is malformed".to_string()) };
    }
    let mut bytes = [0u8; KEY_BYTES];
    fill(&mut bytes)?;
    let encoded = STANDARD.encode(bytes);
    store.set(&encoded)?;
    Ok(encoded)
}

#[cfg(target_os = "macos")]
struct KeyringStore;

#[cfg(target_os = "macos")]
impl KeyStore for KeyringStore {
    fn get(&self) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn set(&self, value: &str) -> Result<(), String> {
        keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?.set_password(value).map_err(|e| e.to_string())
    }
}

static LOCK: Mutex<()> = Mutex::new(());

#[cfg(target_os = "macos")]
fn load_master_key() -> Result<String, String> {
    let _guard = LOCK.lock().map_err(|_| "keychain lock poisoned".to_string())?;
    get_or_create_key(&KeyringStore, |buffer| getrandom::fill(buffer).map_err(|e| e.to_string()))
}

#[cfg(not(target_os = "macos"))]
fn load_master_key() -> Result<String, String> {
    Err("keychain is only available on macOS".to_string())
}

pub async fn master_key() -> Reply {
    let task = tauri::async_runtime::spawn_blocking(load_master_key);
    match tokio::time::timeout(PROMPT_TIMEOUT, task).await {
        Ok(Ok(Ok(key))) => Ok(Some(Value::String(key))),
        Ok(Ok(Err(message))) => Err(WireError::new("KeychainError", message)),
        Ok(Err(_)) => Err(WireError::new("KeychainError", "keychain task failed")),
        Err(_) => Err(WireError::new("KeychainTimeout", "keychain did not respond (authorization prompt unanswered?)")),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};

    use super::*;

    struct Memory(Mutex<Option<String>>, AtomicU32);

    impl Memory {
        fn new(initial: Option<&str>) -> Self {
            Memory(Mutex::new(initial.map(str::to_string)), AtomicU32::new(0))
        }
    }

    impl KeyStore for Memory {
        fn get(&self) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().clone())
        }

        fn set(&self, value: &str) -> Result<(), String> {
            self.1.fetch_add(1, Ordering::SeqCst);
            *self.0.lock().unwrap() = Some(value.to_string());
            Ok(())
        }
    }

    fn deterministic(buffer: &mut [u8]) -> Result<(), String> {
        buffer.iter_mut().enumerate().for_each(|(i, b)| *b = i as u8);
        Ok(())
    }

    #[test]
    fn creates_and_stores_a_32_byte_key_when_none_exists() {
        let store = Memory::new(None);
        let key = get_or_create_key(&store, deterministic).unwrap();
        assert_eq!(STANDARD.decode(&key).unwrap().len(), KEY_BYTES);
        assert_eq!(store.get().unwrap().as_deref(), Some(key.as_str()));
    }

    #[test]
    fn returns_the_existing_key_without_writing() {
        let existing = STANDARD.encode([7u8; KEY_BYTES]);
        let store = Memory::new(Some(&existing));
        assert_eq!(get_or_create_key(&store, |_| Err("must not be called".into())).unwrap(), existing);
        assert_eq!(store.1.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn refuses_to_overwrite_a_malformed_key() {
        for bad in ["not base64!!", &STANDARD.encode([1u8; 16])] {
            let store = Memory::new(Some(bad));
            assert!(get_or_create_key(&store, deterministic).is_err());
            assert_eq!(store.get().unwrap().as_deref(), Some(bad));
        }
    }

    #[test]
    fn surfaces_random_generator_and_store_failures() {
        assert!(get_or_create_key(&Memory::new(None), |_| Err("no entropy".into())).is_err());
    }
}
