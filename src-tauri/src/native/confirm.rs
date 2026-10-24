//! 原生確認框（NSAlert 的 runModal）。核心用 signal 實作逾時：逾時時送取消事件，
//! 這裡要能從外部把正在進行的 modal 結束。
//!
//! 原型實測：modal 進行中 Tauri 的 run_on_main_thread 送不進去，所以中止必須走 GCD 主佇列。
//! modal 期間 Tauri 的事件迴圈暫停，其他視窗與選單事件會延後到對話框結束。

use std::time::Duration;

use serde::Deserialize;
use serde_json::json;
use tokio::sync::oneshot;

use super::{failure, mac, Ctx};
use crate::protocol::Reply;

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmParams {
    /// "warning" | "question"
    pub kind: String,
    #[allow(dead_code)]
    pub title: String,
    pub message: String,
    pub detail: String,
    pub buttons: Vec<String>,
    pub default_id: usize,
    pub cancel_id: usize,
}

/// NSAlertFirstButtonReturn 起算：1000 是第一個按鈕。中止（−1001）或超出範圍都當成取消。
pub fn button_index(response: isize, button_count: usize, cancel_id: usize) -> usize {
    let index = response - 1000;
    if index >= 0 && (index as usize) < button_count {
        index as usize
    } else {
        cancel_id
    }
}

/// 中止要重送：modal 還沒真正開始時第一次中止會落空。
const ABORT_RETRY: Duration = Duration::from_millis(150);

pub async fn show(ctx: &Ctx, params: ConfirmParams) -> Reply {
    if params.buttons.is_empty() {
        return Ok(Some(json!(params.cancel_id)));
    }
    let (tx, mut rx) = oneshot::channel::<isize>();
    let cancel = ctx.cancel.clone();
    let for_main = params.clone();
    ctx.app
        .run_on_main_thread(move || {
            if cancel.is_cancelled() {
                let _ = tx.send(mac::MODAL_ABORTED);
                return;
            }
            let _ = tx.send(mac::run_alert(&for_main));
        })
        .map_err(failure)?;

    let response = tokio::select! {
        result = &mut rx => result.unwrap_or(mac::MODAL_ABORTED),
        _ = ctx.cancel.cancelled() => loop {
            mac::abort_modal();
            if let Ok(result) = tokio::time::timeout(ABORT_RETRY, &mut rx).await {
                break result.unwrap_or(mac::MODAL_ABORTED);
            }
        },
    };
    Ok(Some(json!(button_index(response, params.buttons.len(), params.cancel_id))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_alert_responses_to_button_indexes() {
        assert_eq!(button_index(1000, 2, 0), 0);
        assert_eq!(button_index(1001, 2, 0), 1);
        // 中止、關閉、超出範圍都回到取消按鈕。
        assert_eq!(button_index(-1001, 2, 1), 1);
        assert_eq!(button_index(1002, 2, 0), 0);
        assert_eq!(button_index(0, 2, 1), 1);
    }
}
