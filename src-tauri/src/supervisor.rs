//! 核心（Node sidecar）的連線監督：連上 unix socket、握手、等核心就緒，
//! 斷線後以指數退避重連。開發時 sidecar 由 scripts/dev.ts 啟動並獨立存活，
//! Rust 重編重啟後重新連上即可，核心的狀態與資料不受影響。

use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{unix::OwnedReadHalf, UnixStream},
    sync::{mpsc, oneshot, watch},
};

use crate::protocol::{
    encode_frame, parse_frame, Frame, Reply, WireError, EVENT_CANCEL, EVENT_PUSH, EVENT_READY, MAX_FRAME_BYTES, METHOD_HELLO,
    METHOD_IPC_INVOKE, NATIVE_PREFIX, PROTOCOL_VERSION,
};

/// Rust 轉送核心推播給前端用的事件名稱、核心上線／離線事件（前端 shim 使用相同字串）。
pub const PUSH_EVENT: &str = "gitnrun:push";
pub const SIDECAR_EVENT: &str = "gitnrun:sidecar";

/// 前端的呼叫在核心尚未就緒時最多等這麼久（冷啟動時畫面可能比核心先好）。
const READY_WAIT: Duration = Duration::from_secs(15);

/// 指數退避：base、2×base、4×base…，不超過 max。
#[derive(Debug, Clone)]
pub struct Backoff {
    base: Duration,
    max: Duration,
    attempt: u32,
}

impl Backoff {
    pub fn new(base: Duration, max: Duration) -> Self {
        Backoff { base, max, attempt: 0 }
    }

    pub fn next_delay(&mut self) -> Duration {
        let factor = 1u32.checked_shl(self.attempt.min(16)).unwrap_or(u32::MAX);
        self.attempt = self.attempt.saturating_add(1);
        self.base.saturating_mul(factor).min(self.max)
    }

    pub fn reset(&mut self) {
        self.attempt = 0;
    }
}

/// 時間窗內的重啟額度，避免崩潰迴圈無限重來（渲染程序重載、正式版重生 sidecar 共用）。
#[derive(Debug)]
pub struct RestartBudget {
    max: usize,
    window: Duration,
    stamps: VecDeque<Instant>,
}

impl RestartBudget {
    pub fn new(max: usize, window: Duration) -> Self {
        RestartBudget { max, window, stamps: VecDeque::new() }
    }

    /// 嘗試記錄一次重啟；額度用完回傳 false，不記錄。
    pub fn try_record(&mut self, now: Instant) -> bool {
        while let Some(oldest) = self.stamps.front() {
            if now.duration_since(*oldest) > self.window {
                self.stamps.pop_front();
            } else {
                break;
            }
        }
        if self.stamps.len() >= self.max {
            return false;
        }
        self.stamps.push_back(now);
        true
    }
}

/// 核心取消一個進行中的原生請求（例如確認框逾時）時用的訊號。
/// 取消事件可能比請求的處理任務先到，所以先記旗標並留一個通知，晚到的等待者也看得到。
#[derive(Clone, Default)]
pub struct CancelToken {
    flag: Arc<std::sync::atomic::AtomicBool>,
    notify: Arc<tokio::sync::Notify>,
}

impl CancelToken {
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_one();
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    pub async fn cancelled(&self) {
        if !self.is_cancelled() {
            self.notify.notified().await;
        }
    }
}

struct Shared {
    external: Mutex<crate::external::Pending>,
    cancels: Mutex<HashMap<u64, CancelToken>>,
    writer: Mutex<Option<mpsc::UnboundedSender<String>>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    next_id: AtomicU64,
    /// 核心已啟動完成（收到 ready 事件）；前端的呼叫要等它。
    ready: watch::Sender<bool>,
}

#[derive(Clone)]
pub struct SidecarHandle(Arc<Shared>);

impl SidecarHandle {
    pub fn new() -> Self {
        let (ready, _) = watch::channel(false);
        SidecarHandle(Arc::new(Shared {
            external: Mutex::new(crate::external::Pending::default()),
            cancels: Mutex::new(HashMap::new()),
            writer: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            ready,
        }))
    }

    pub fn is_ready(&self) -> bool {
        *self.0.ready.borrow()
    }

    fn send_line(&self, line: String) -> Result<(), WireError> {
        let writer = self.0.writer.lock().expect("writer lock");
        match writer.as_ref() {
            Some(tx) => tx.send(line).map_err(|_| WireError::unavailable("core connection closed")),
            None => Err(WireError::unavailable("core is not connected")),
        }
    }

    /// 單向事件，盡力送出。
    pub fn send_event(&self, method: &str, params: Option<Value>) {
        if let Some(line) = encode_frame(&Frame::Evt { method: method.to_string(), params }) {
            let _ = self.send_line(line);
        }
    }

    pub async fn request(&self, method: &str, params: Option<Value>) -> Reply {
        let id = self.0.next_id.fetch_add(1, Ordering::Relaxed);
        let line = encode_frame(&Frame::Req { id, method: method.to_string(), params })
            .ok_or_else(|| WireError::new("RequestTooLarge", "request is larger than the frame limit"))?;
        let (tx, rx) = oneshot::channel();
        self.0.pending.lock().expect("pending lock").insert(id, tx);
        if let Err(error) = self.send_line(line) {
            self.0.pending.lock().expect("pending lock").remove(&id);
            return Err(error);
        }
        rx.await.unwrap_or_else(|_| Err(WireError::unavailable("core connection closed")))
    }

    async fn wait_ready(&self, timeout: Duration) -> bool {
        let mut rx = self.0.ready.subscribe();
        let outcome = tokio::time::timeout(timeout, rx.wait_for(|ready| *ready)).await;
        matches!(outcome, Ok(Ok(_)))
    }

    /// 外部開啟請求：核心就緒就直接送，否則先排隊，等 ready 時依序送出。
    pub fn open_external(&self, request: Value) {
        if self.is_ready() {
            self.send_event("external-open", Some(request));
        } else {
            self.0.external.lock().expect("external lock").push(request);
        }
    }

    fn flush_external(&self) {
        let queued = self.0.external.lock().expect("external lock").drain();
        for request in queued {
            self.send_event("external-open", Some(request));
        }
    }

    /// 前端的 IPC 呼叫：通道與參數原樣轉給核心，驗證都在核心。回傳核心的信封（{} 或 {value}）。
    pub async fn invoke(&self, channel: &str, args: Vec<Value>) -> Result<Value, WireError> {
        if !self.wait_ready(READY_WAIT).await {
            return Err(WireError::unavailable("core is not ready"));
        }
        let reply = self.request(METHOD_IPC_INVOKE, Some(json!({ "channel": channel, "args": args }))).await?;
        Ok(reply.unwrap_or(Value::Null))
    }

    /// 收到原生請求時立刻登記（取消事件緊接著到也找得到）；處理完成後要呼叫 finish_native。
    fn begin_native(&self, id: u64) -> CancelToken {
        let token = CancelToken::default();
        self.0.cancels.lock().expect("cancel lock").insert(id, token.clone());
        token
    }

    fn finish_native(&self, id: u64) {
        self.0.cancels.lock().expect("cancel lock").remove(&id);
    }

    fn cancel_native(&self, id: u64) {
        if let Some(token) = self.0.cancels.lock().expect("cancel lock").get(&id) {
            token.cancel();
        }
    }

    fn fail_all(&self) {
        let drained: Vec<_> = self.0.pending.lock().expect("pending lock").drain().collect();
        for (_, tx) in drained {
            let _ = tx.send(Err(WireError::unavailable("core connection closed")));
        }
    }

    fn resolve(&self, id: u64, result: Reply) {
        if let Some(tx) = self.0.pending.lock().expect("pending lock").remove(&id) {
            let _ = tx.send(result);
        }
    }
}

impl Default for SidecarHandle {
    fn default() -> Self {
        Self::new()
    }
}

/// 握手時交給核心的外殼資訊。
#[derive(Debug, Clone)]
pub struct HostInfo {
    pub app_name: String,
    pub app_version: String,
    pub data_dir: PathBuf,
    pub packaged: bool,
}

#[derive(Debug, Clone)]
pub struct SidecarConfig {
    pub socket_path: PathBuf,
    pub token: String,
    pub host: HostInfo,
}

fn hello_params(config: &SidecarConfig) -> Value {
    json!({
        "v": PROTOCOL_VERSION,
        "token": config.token,
        "appName": config.host.app_name,
        "appVersion": config.host.app_version,
        "platform": if cfg!(target_os = "macos") { "darwin" } else { std::env::consts::OS },
        "dataDir": config.host.data_dir,
        "packaged": config.host.packaged,
    })
}

/// 永遠連線：斷了就退避後重連。
pub async fn supervise(app: AppHandle, handle: SidecarHandle, config: SidecarConfig) {
    let mut backoff = Backoff::new(Duration::from_millis(100), Duration::from_secs(2));
    loop {
        if let Ok(stream) = UnixStream::connect(&config.socket_path).await {
            backoff.reset();
            run_session(&app, &handle, &config, stream).await;
        }
        tokio::time::sleep(backoff.next_delay()).await;
    }
}

async fn run_session(app: &AppHandle, handle: &SidecarHandle, config: &SidecarConfig, stream: UnixStream) {
    let (read_half, mut write_half) = stream.into_split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    *handle.0.writer.lock().expect("writer lock") = Some(tx);

    let writer = tauri::async_runtime::spawn(async move {
        while let Some(line) = rx.recv().await {
            if write_half.write_all(line.as_bytes()).await.is_err() {
                break;
            }
        }
    });
    let reader = tauri::async_runtime::spawn(read_loop(app.clone(), handle.clone(), read_half));

    let hello = {
        let handle = handle.clone();
        let params = hello_params(config);
        tauri::async_runtime::spawn(async move { handle.request(METHOD_HELLO, Some(params)).await })
    };

    // 讀取端結束 = 連線斷了（含 hello 被拒絕時核心主動斷線）。
    let _ = reader.await;

    handle.0.writer.lock().expect("writer lock").take();
    handle.0.ready.send_replace(false);
    handle.fail_all();
    writer.abort();
    // 核心之前註冊的全域快捷鍵屬於它；核心重啟後會重新註冊，不清掉的話新核心會被當成「已被占用」。
    let _ = app.global_shortcut().unregister_all();
    if let Ok(Err(error)) = hello.await {
        eprintln!("[gitnrun] core hello failed: {}", error.name);
    }
    let _ = app.emit(SIDECAR_EVENT, json!({ "online": false }));
}

async fn read_loop(app: AppHandle, handle: SidecarHandle, read_half: OwnedReadHalf) {
    let mut reader = BufReader::new(read_half);
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        // 每次最多讀上限＋1 個位元組：超過上限仍沒看到換行就視為超長訊息，直接斷線。
        let read = (&mut reader).take(MAX_FRAME_BYTES as u64 + 1).read_until(b'\n', &mut buffer).await;
        match read {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        if buffer.last() != Some(&b'\n') {
            return;
        }
        let line = String::from_utf8_lossy(&buffer[..buffer.len() - 1]);
        if line.is_empty() {
            continue;
        }
        let Some(frame) = parse_frame(&line) else { return };
        dispatch(&app, &handle, frame);
    }
}

fn dispatch(app: &AppHandle, handle: &SidecarHandle, frame: Frame) {
    match frame {
        Frame::Res { id, result } => handle.resolve(id, result),
        Frame::Evt { method, params } => {
            if method == EVENT_READY {
                handle.0.ready.send_replace(true);
                handle.flush_external();
                let _ = app.emit(SIDECAR_EVENT, json!({ "online": true }));
            } else if method == EVENT_PUSH {
                if let Some(payload) = params {
                    let _ = app.emit(PUSH_EVENT, payload);
                }
            } else if method == EVENT_CANCEL {
                if let Some(id) = params.as_ref().and_then(|p| p.get("id")).and_then(Value::as_u64) {
                    handle.cancel_native(id);
                }
            }
        }
        Frame::Req { id, method, params } => {
            if !method.starts_with(NATIVE_PREFIX) {
                reply(handle, id, Err(WireError::new("Error", "unknown method")));
                return;
            }
            let app = app.clone();
            let handle = handle.clone();
            let cancel = handle.begin_native(id);
            tauri::async_runtime::spawn(async move {
                let ctx = crate::native::Ctx { app: app.clone(), cancel };
                let result = crate::native::handle(ctx, handle.clone(), &method, params).await;
                handle.finish_native(id);
                reply(&handle, id, result);
            });
        }
    }
}

fn reply(handle: &SidecarHandle, id: u64, result: Reply) {
    if let Some(line) = encode_frame(&Frame::Res { id, result }) {
        let _ = handle.send_line(line);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_cancel_that_arrives_early_is_still_seen_by_a_late_waiter() {
        let handle = SidecarHandle::new();
        let token = handle.begin_native(9);
        handle.cancel_native(9);
        // 取消先到、才開始等待：不能卡住。
        tokio::time::timeout(Duration::from_millis(200), token.cancelled()).await.expect("sees the earlier cancel");
        assert!(token.is_cancelled());

        handle.finish_native(9);
        handle.cancel_native(9); // 已結束的請求再收到取消：安靜略過。
    }

    #[test]
    fn backoff_doubles_up_to_the_cap_and_resets() {
        let mut backoff = Backoff::new(Duration::from_millis(100), Duration::from_secs(2));
        let delays: Vec<_> = (0..7).map(|_| backoff.next_delay().as_millis()).collect();
        assert_eq!(delays, vec![100, 200, 400, 800, 1600, 2000, 2000]);
        backoff.reset();
        assert_eq!(backoff.next_delay().as_millis(), 100);
    }

    #[test]
    fn backoff_never_overflows() {
        let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(5));
        for _ in 0..200 {
            assert!(backoff.next_delay() <= Duration::from_secs(5));
        }
    }

    #[test]
    fn restart_budget_stops_a_crash_loop_and_recovers_after_the_window() {
        let start = Instant::now();
        let mut budget = RestartBudget::new(3, Duration::from_secs(60));
        assert!(budget.try_record(start));
        assert!(budget.try_record(start + Duration::from_secs(1)));
        assert!(budget.try_record(start + Duration::from_secs(2)));
        assert!(!budget.try_record(start + Duration::from_secs(3)));
        assert!(!budget.try_record(start + Duration::from_secs(59)));
        // 最舊的一筆滑出時間窗後又有額度。
        assert!(budget.try_record(start + Duration::from_secs(61)));
    }

    #[test]
    fn external_requests_wait_for_the_core_and_then_go_out_in_order() {
        let handle = SidecarHandle::new();
        let (tx, mut rx) = mpsc::unbounded_channel();
        *handle.0.writer.lock().unwrap() = Some(tx);

        handle.open_external(json!({ "kind": "file", "value": "/a" }));
        handle.open_external(json!({ "kind": "file", "value": "/b" }));
        assert!(rx.try_recv().is_err(), "nothing is sent before the core is ready");

        handle.0.ready.send_replace(true);
        handle.flush_external();
        handle.open_external(json!({ "kind": "file", "value": "/c" }));
        let sent: Vec<String> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
        assert_eq!(sent.len(), 3);
        for (line, expected) in sent.iter().zip(["/a", "/b", "/c"]) {
            let Some(Frame::Evt { method, params }) = parse_frame(line.trim_end()) else { panic!("not an event: {line}") };
            assert_eq!(method, "external-open");
            assert_eq!(params.unwrap()["value"], expected);
        }
    }

    #[tokio::test]
    async fn requests_fail_fast_while_the_core_is_not_connected() {
        let handle = SidecarHandle::new();
        let error = handle.request("native.x", None).await.unwrap_err();
        assert_eq!(error.name, "SidecarUnavailable");
        assert!(!handle.is_ready());
    }

    #[tokio::test]
    async fn invoke_gives_up_when_the_core_never_becomes_ready() {
        let handle = SidecarHandle::new();
        assert!(!handle.wait_ready(Duration::from_millis(30)).await);
        handle.0.ready.send_replace(true);
        assert!(handle.wait_ready(Duration::from_millis(30)).await);
    }

    #[tokio::test]
    async fn a_response_resolves_its_request_and_a_disconnect_fails_the_rest() {
        let handle = SidecarHandle::new();
        let (tx, mut rx) = mpsc::unbounded_channel();
        *handle.0.writer.lock().unwrap() = Some(tx);

        let first = tokio::spawn({
            let handle = handle.clone();
            async move { handle.request("a", None).await }
        });
        let second = tokio::spawn({
            let handle = handle.clone();
            async move { handle.request("b", None).await }
        });
        let mut ids = Vec::new();
        for _ in 0..2 {
            let line = rx.recv().await.unwrap();
            if let Some(Frame::Req { id, method, .. }) = parse_frame(line.trim_end()) {
                ids.push((method, id));
            }
        }
        let id_of = |name: &str| ids.iter().find(|(m, _)| m == name).unwrap().1;
        handle.resolve(id_of("a"), Ok(Some(json!(42))));
        assert_eq!(first.await.unwrap(), Ok(Some(json!(42))));

        handle.fail_all();
        assert_eq!(second.await.unwrap().unwrap_err().name, "SidecarUnavailable");
    }
}
