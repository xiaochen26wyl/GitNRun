//! 外部開啟請求（`gitnrun://launch?path=`、Finder 把資料夾交給 app、拖到 Dock 圖示）。
//!
//! 原型實測：`RunEvent::Opened` 在冷啟動時比 setup 更早到、暖啟動也會送；資料夾以 `file://` 網址送來
//! （路徑已解析 /tmp → /private/tmp，並帶結尾斜線）。所以事件先在這裡排隊（上限 20 筆、重複的略過），
//! 核心就緒後依序交給核心既有的外部開啟閘門；要正規化成與 Electron `open-file` 相同的路徑。

use std::collections::VecDeque;

use serde_json::{json, Value};
use tauri::Url;

/// 核心就緒之前最多留幾筆，避免被不斷塞請求而無限增長。
pub const MAX_PENDING: usize = 20;

/// 轉成核心認得的請求：`{ kind: "url" | "file", value }`；不認得的網址回傳 None。
pub fn to_request(url: &Url) -> Option<Value> {
    match url.scheme() {
        "gitnrun" => Some(json!({ "kind": "url", "value": url.as_str() })),
        "file" => {
            let path = url.to_file_path().ok()?;
            let text = path.to_str()?;
            // Electron 的 open-file 給的路徑沒有結尾斜線（根目錄除外）。
            let trimmed = if text.len() > 1 { text.trim_end_matches('/') } else { text };
            Some(json!({ "kind": "file", "value": trimmed }))
        }
        _ => None,
    }
}

#[derive(Debug, Default)]
pub struct Pending {
    queue: VecDeque<Value>,
}

impl Pending {
    pub fn push(&mut self, request: Value) {
        if self.queue.contains(&request) || self.queue.len() >= MAX_PENDING {
            return;
        }
        self.queue.push_back(request);
    }

    pub fn drain(&mut self) -> Vec<Value> {
        self.queue.drain(..).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    #[test]
    fn passes_the_app_scheme_through_untouched() {
        let request = to_request(&url("gitnrun://launch?path=%2FUsers%2Fme%2Fproj")).unwrap();
        assert_eq!(request, json!({ "kind": "url", "value": "gitnrun://launch?path=%2FUsers%2Fme%2Fproj" }));
    }

    #[test]
    fn turns_a_folder_url_into_the_plain_path_electron_would_give() {
        assert_eq!(to_request(&url("file:///private/tmp/my%20project/")), Some(json!({ "kind": "file", "value": "/private/tmp/my project" })));
        assert_eq!(to_request(&url("file:///Users/me/proj")), Some(json!({ "kind": "file", "value": "/Users/me/proj" })));
        assert_eq!(to_request(&url("file:///")), Some(json!({ "kind": "file", "value": "/" })));
    }

    #[test]
    fn ignores_other_schemes_and_remote_file_hosts() {
        assert_eq!(to_request(&url("https://example.com/")), None);
        assert_eq!(to_request(&url("javascript:alert(1)")), None);
        assert_eq!(to_request(&url("file://otherhost/share/x")), None);
    }

    #[test]
    fn keeps_at_most_twenty_distinct_requests_in_arrival_order() {
        let mut pending = Pending::default();
        for index in 0..30 {
            pending.push(json!({ "kind": "file", "value": format!("/p/{index}") }));
        }
        pending.push(json!({ "kind": "file", "value": "/p/0" }));
        let drained = pending.drain();
        assert_eq!(drained.len(), MAX_PENDING);
        assert_eq!(drained[0]["value"], "/p/0");
        assert_eq!(drained[19]["value"], "/p/19");
        assert!(pending.drain().is_empty());
    }

    #[test]
    fn does_not_queue_the_same_request_twice() {
        let mut pending = Pending::default();
        let request = json!({ "kind": "url", "value": "gitnrun://launch?path=%2Fa" });
        pending.push(request.clone());
        pending.push(request);
        assert_eq!(pending.drain().len(), 1);
    }
}
