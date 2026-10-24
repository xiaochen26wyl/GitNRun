//! 正式版由 Rust 啟動並看管核心（內附 Node 執行 sidecar）。開發時 sidecar 由 scripts/dev.ts 啟動，不走這裡。
//!
//! 結束碼的約定與 src/main/sidecar/protocol.ts 一致：0 = 正常結束（⌘Q）、75 = 核心要求重啟、
//! 78 = 不要重啟（例如另一個核心占著資料夾）；其他（含被訊號殺掉）視為當掉。
//! 重啟有額度：時間窗內重啟太多次就放棄並告知使用者，避免崩潰迴圈。

use std::{
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant},
};

use tokio::{
    process::{Child, Command},
    sync::{oneshot, Notify},
};

use crate::supervisor::{Backoff, RestartBudget};

/// 核心要求重啟（與 protocol.ts 的 EXIT_RESTART 相同）；落在 after_exit 的「其他結束碼」分支，這裡留常數供測試與對照。
#[allow(dead_code)]
pub const EXIT_RESTART: i32 = 75;
pub const EXIT_NO_RESTART: i32 = 78;

/// 核心的 Node 旗標，必須與 scripts/node-runtime.ts 的 SIDECAR_NODE_FLAGS 相同（tests/sidecar-node-flags.test.ts 檢查）。
/// 實測：限制新生代大小，同樣負載下核心的記憶體從約 88 MB 降到約 38 MB。
pub const NODE_FLAGS: [&str; 2] = ["--max-semi-space-size=1", "--max-old-space-size=128"];

/// 時間窗內最多重啟幾次。
const MAX_RESTARTS: usize = 5;
const RESTART_WINDOW: Duration = Duration::from_secs(60);

#[derive(Debug, PartialEq, Eq)]
pub enum AfterExit {
    /// 核心自己正常結束，不再重啟。
    Done,
    Respawn,
    /// 核心明確要求不要重啟。
    Refused,
    /// 重啟額度用完。
    GiveUp,
}

pub fn after_exit(code: Option<i32>, budget: &mut RestartBudget, now: Instant) -> AfterExit {
    match code {
        Some(0) => AfterExit::Done,
        Some(EXIT_NO_RESTART) => AfterExit::Refused,
        // 75、其他結束碼、被訊號殺掉：重啟，但受額度限制。
        _ if budget.try_record(now) => AfterExit::Respawn,
        _ => AfterExit::GiveUp,
    }
}

/// 內附的 Node 與核心腳本的位置：Node 在主程式旁（externalBin 去掉三元組後的名稱），腳本在 Resources。
pub fn sidecar_paths(exe: &Path, resource_dir: &Path) -> Option<(PathBuf, PathBuf)> {
    Some((exe.parent()?.join("gitnrun-node"), resource_dir.join("sidecar").join("index.cjs")))
}

/// unix socket 放在暫存目錄底下自己專屬的資料夾（核心會把資料夾建成 0700）。
pub fn socket_path(tmp: &Path, uid: u32) -> PathBuf {
    tmp.join(format!("gitnrun-{uid}")).join("core.sock")
}

/// 每次啟動隨機產生的連線憑證（64 個十六進位字元）。
pub fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[derive(Debug, Clone)]
pub struct LaunchConfig {
    pub node: PathBuf,
    pub script: PathBuf,
    pub socket_path: PathBuf,
    pub token: String,
    /// 核心的 stdout／stderr 寫到這裡（打包後沒有終端機可看）。
    pub log_path: PathBuf,
    /// 放在腳本路徑之前的 Node 旗標；正式設定一律用 NODE_FLAGS。
    pub node_args: Vec<String>,
}

impl LaunchConfig {
    /// 正式版的設定：帶上記憶體旗標。
    pub fn bundled(node: PathBuf, script: PathBuf, socket_path: PathBuf, token: String, log_path: PathBuf) -> Self {
        LaunchConfig { node, script, socket_path, token, log_path, node_args: NODE_FLAGS.iter().map(|flag| flag.to_string()).collect() }
    }
}

fn open_log(path: &Path, truncate: bool) -> std::io::Result<File> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if truncate {
        File::create(path)
    } else {
        OpenOptions::new().create(true).append(true).open(path)
    }
}

fn spawn(config: &LaunchConfig, first: bool) -> std::io::Result<Child> {
    let log = open_log(&config.log_path, first)?;
    Command::new(&config.node)
        .args(&config.node_args)
        .arg(&config.script)
        .env("GITNRUN_SIDECAR_SOCKET", &config.socket_path)
        .env("GITNRUN_SIDECAR_TOKEN", &config.token)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone()?))
        .stderr(Stdio::from(log))
        // Rust 殼結束時（含當掉）不留下孤兒核心。
        .kill_on_drop(true)
        .spawn()
}

/// 看管迴圈：啟動核心、依結束碼決定重啟或停止。回報使用者的事（無法啟動、放棄重啟）交給 on_fatal。
async fn run(config: LaunchConfig, stop: Arc<Notify>, grace: Duration, on_fatal: impl Fn(String), done: oneshot::Sender<()>) {
    let mut budget = RestartBudget::new(MAX_RESTARTS, RESTART_WINDOW);
    let mut backoff = Backoff::new(Duration::from_millis(200), Duration::from_secs(3));
    let mut first = true;

    loop {
        let mut child = match spawn(&config, first) {
            Ok(child) => child,
            Err(error) => {
                on_fatal(format!("無法啟動 GitNRun 的核心：{error}"));
                break;
            }
        };
        first = false;

        tokio::select! {
            status = child.wait() => {
                let code = status.ok().and_then(|status| status.code());
                match after_exit(code, &mut budget, Instant::now()) {
                    AfterExit::Done => break,
                    AfterExit::Refused => {
                        on_fatal("GitNRun 的核心拒絕啟動（資料夾可能正被另一個 GitNRun 使用）。請關閉其他 GitNRun 後重新開啟。".to_string());
                        break;
                    }
                    AfterExit::GiveUp => {
                        on_fatal("GitNRun 的核心在短時間內多次異常結束，已停止自動重啟。請到資料夾裡的 sidecar.log 查看原因，或重新開啟 GitNRun。".to_string());
                        break;
                    }
                    AfterExit::Respawn => tokio::time::sleep(backoff.next_delay()).await,
                }
            }
            _ = stop.notified() => {
                // 呼叫端已請核心自己收尾；等一下再強制結束。
                if tokio::time::timeout(grace, child.wait()).await.is_err() {
                    let _ = child.kill().await;
                }
                break;
            }
        }
    }
    let _ = done.send(());
}

/// 開發版（debug）由 dev 腳本看管核心，不會用到這個型別。
#[cfg_attr(debug_assertions, allow(dead_code))]
pub struct Launcher {
    stop: Arc<Notify>,
    done: std::sync::Mutex<Option<oneshot::Receiver<()>>>,
}

#[cfg_attr(debug_assertions, allow(dead_code))]
impl Launcher {
    pub fn start(config: LaunchConfig, on_fatal: impl Fn(String) + Send + 'static) -> Launcher {
        let stop = Arc::new(Notify::new());
        let (tx, rx) = oneshot::channel();
        tauri::async_runtime::spawn(run(config, stop.clone(), Duration::from_secs(3), on_fatal, tx));
        Launcher { stop, done: std::sync::Mutex::new(Some(rx)) }
    }

    /// 結束時呼叫：通知看管迴圈收尾並等它結束（最多 timeout）。
    pub async fn shutdown(&self, timeout: Duration) {
        self.stop.notify_one();
        let rx = self.done.lock().expect("launcher lock").take();
        if let Some(rx) = rx {
            let _ = tokio::time::timeout(timeout, rx).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        sync::{Arc, Mutex},
    };

    use super::*;

    fn budget() -> RestartBudget {
        RestartBudget::new(MAX_RESTARTS, RESTART_WINDOW)
    }

    #[test]
    fn exit_codes_decide_what_happens_next() {
        let now = Instant::now();
        assert_eq!(after_exit(Some(0), &mut budget(), now), AfterExit::Done);
        assert_eq!(after_exit(Some(EXIT_NO_RESTART), &mut budget(), now), AfterExit::Refused);
        assert_eq!(after_exit(Some(EXIT_RESTART), &mut budget(), now), AfterExit::Respawn);
        assert_eq!(after_exit(Some(1), &mut budget(), now), AfterExit::Respawn);
        // 被訊號殺掉沒有結束碼，視為當掉。
        assert_eq!(after_exit(None, &mut budget(), now), AfterExit::Respawn);
    }

    #[test]
    fn a_crash_loop_gives_up_and_a_clean_exit_never_spends_budget() {
        let now = Instant::now();
        let mut spent = budget();
        for _ in 0..MAX_RESTARTS {
            assert_eq!(after_exit(Some(1), &mut spent, now), AfterExit::Respawn);
        }
        assert_eq!(after_exit(Some(1), &mut spent, now), AfterExit::GiveUp);
        assert_eq!(after_exit(Some(EXIT_RESTART), &mut spent, now), AfterExit::GiveUp);
        // 額度用完後，正常結束與明確拒絕仍照原意處理。
        assert_eq!(after_exit(Some(0), &mut spent, now), AfterExit::Done);
        assert_eq!(after_exit(Some(EXIT_NO_RESTART), &mut spent, now), AfterExit::Refused);
    }

    #[test]
    fn locates_the_bundled_node_and_script() {
        let (node, script) = sidecar_paths(Path::new("/Applications/GitNRun.app/Contents/MacOS/gitnrun"), Path::new("/Applications/GitNRun.app/Contents/Resources")).unwrap();
        assert_eq!(node, PathBuf::from("/Applications/GitNRun.app/Contents/MacOS/gitnrun-node"));
        assert_eq!(script, PathBuf::from("/Applications/GitNRun.app/Contents/Resources/sidecar/index.cjs"));
        assert_eq!(socket_path(Path::new("/var/folders/ab/T"), 501), PathBuf::from("/var/folders/ab/T/gitnrun-501/core.sock"));
    }

    #[test]
    fn node_flags_cap_the_young_generation_and_the_old_generation() {
        assert!(NODE_FLAGS.contains(&"--max-semi-space-size=1"));
        assert!(NODE_FLAGS.iter().any(|flag| flag.starts_with("--max-old-space-size=")));
        // 旗標都要放在腳本路徑之前才會被 Node 當成選項。
        assert!(NODE_FLAGS.iter().all(|flag| flag.starts_with("--")));
    }

    #[test]
    fn the_bundled_config_always_carries_the_memory_flags() {
        let config = LaunchConfig::bundled(PathBuf::from("n"), PathBuf::from("s.cjs"), PathBuf::from("sock"), "t".into(), PathBuf::from("log"));
        assert_eq!(config.node_args, NODE_FLAGS.to_vec());
    }

    /// 找得到 node 才測（CI 與本機都有；沒有就略過）。Node 對不認得的旗標會以錯誤碼結束。
    #[test]
    fn node_accepts_the_memory_flags() {
        let Some(node) = std::env::var_os("PATH").and_then(|paths| std::env::split_paths(&paths).map(|dir| dir.join("node")).find(|path| path.is_file())) else {
            eprintln!("skipped: no node on PATH");
            return;
        };
        let status = std::process::Command::new(node).args(NODE_FLAGS).args(["-e", "process.exit(0)"]).status().expect("runs node");
        assert!(status.success(), "node rejected {NODE_FLAGS:?}");
    }

    #[test]
    fn tokens_are_long_hex_and_never_repeat() {
        let (a, b) = (random_token().unwrap(), random_token().unwrap());
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gnr-launch-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn config(dir: &Path, script_body: &str) -> LaunchConfig {
        let script = dir.join("sidecar.sh");
        fs::write(&script, script_body).unwrap();
        LaunchConfig {
            node: PathBuf::from("/bin/sh"),
            script,
            socket_path: dir.join("s.sock"),
            token: "t".repeat(40),
            log_path: dir.join("sidecar.log"),
            // 測試用 /bin/sh 當假的 node，不能收到 V8 旗標。
            node_args: Vec::new(),
        }
    }

    #[tokio::test]
    async fn respawns_a_crashing_child_until_the_budget_runs_out_then_reports() {
        let dir = scratch("crash");
        let counter = dir.join("runs");
        let cfg = config(&dir, &format!("echo x >> {}\nexit 75\n", counter.display()));
        let fatal = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = fatal.clone();
        let (tx, rx) = oneshot::channel();
        // 退避在測試裡不能太久：直接跑迴圈，等它自己放棄。
        tokio::time::timeout(Duration::from_secs(30), run(cfg, Arc::new(Notify::new()), Duration::from_secs(1), move |m| sink.lock().unwrap().push(m), tx))
            .await
            .expect("loop gives up on its own");
        assert!(rx.await.is_ok());

        let runs = fs::read_to_string(&counter).unwrap().lines().count();
        assert_eq!(runs, MAX_RESTARTS + 1, "first start plus the allowed restarts");
        let messages = fatal.lock().unwrap();
        assert_eq!(messages.len(), 1);
        assert!(messages[0].contains("sidecar.log"));
        fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_clean_exit_stops_without_a_report_and_78_reports_once() {
        for (code, expect_report) in [(0, false), (78, true)] {
            let dir = scratch(&format!("exit{code}"));
            let cfg = config(&dir, &format!("exit {code}\n"));
            let fatal = Arc::new(Mutex::new(0usize));
            let sink = fatal.clone();
            let (tx, _rx) = oneshot::channel();
            run(cfg, Arc::new(Notify::new()), Duration::from_secs(1), move |_| *sink.lock().unwrap() += 1, tx).await;
            assert_eq!(*fatal.lock().unwrap(), usize::from(expect_report), "exit {code}");
            fs::remove_dir_all(&dir).ok();
        }
    }

    #[tokio::test]
    async fn shutdown_stops_a_healthy_child_and_a_missing_binary_is_reported() {
        let dir = scratch("stop");
        let cfg = config(&dir, "sleep 30\n");
        let launcher = Launcher::start(cfg, |_| {});
        tokio::time::sleep(Duration::from_millis(300)).await;
        let started = Instant::now();
        launcher.shutdown(Duration::from_secs(8)).await;
        // grace 3 秒內孩子沒結束就被強制結束，不會等滿 30 秒。
        assert!(started.elapsed() < Duration::from_secs(8));

        let mut missing = config(&dir, "exit 0\n");
        missing.node = dir.join("no-such-node");
        let fatal = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = fatal.clone();
        let (tx, _rx) = oneshot::channel();
        run(missing, Arc::new(Notify::new()), Duration::from_secs(1), move |m| sink.lock().unwrap().push(m), tx).await;
        assert_eq!(fatal.lock().unwrap().len(), 1);
        fs::remove_dir_all(&dir).ok();
    }
}
