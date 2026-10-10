import { app, BrowserWindow } from "electron";
import { IPC, type AppInfo } from "@shared/ipc";
import { registerAiIpc } from "@main/ai/ipc";
import { createAnthropicClient, createOpenAiClient } from "@main/ai/providers";
import { createAiService } from "@main/ai/service";
import { createAppHandlers } from "@main/app-handlers";
import { registerAppIpc } from "@main/app-ipc";
import { createAppSettingsHandlers } from "@main/app-settings";
import { registerAppSettingsIpc } from "@main/app-settings-ipc";
import { copySecretToClipboard } from "@main/clipboard-secret";
import { backupSoon, closeDataLayer, getBackupDir, initDataLayer } from "@main/data-layer";
import { markInterruptedExecutions } from "@main/db/rule-executions-repo";
import { runGit } from "@main/git/run-git";
import { readProjectVersion } from "@main/git/version-source";
import { handleIpc } from "@main/ipc";
import { asNoArgs } from "@main/ipc-validation";
import { createExternalOpenGate } from "@main/launcher/external";
import { registerLauncherIpc } from "@main/launcher/ipc";
import { createLauncherRuntime } from "@main/launcher/runtime";
import { registerRunIpc } from "@main/run/ipc";
import { createRunRuntime } from "@main/run/runtime";
import { createLogger, type Logger } from "@main/logger";
import { createEventPipeline, createMonitorRuntime, emitMonitorChange, onMonitorChange } from "@main/monitor/runtime";
import { installProcessGuards } from "@main/reliability/process-guards";
import { createRulesHandlers } from "@main/rules/handlers";
import { registerRulesIpc } from "@main/rules/ipc";
import { createRuleRuntime } from "@main/rules/runtime";
import { registerSecretsIpc } from "@main/secrets-ipc";
import { initVault } from "@main/vault/runtime";
import { createWebhookAdminHandlers } from "@main/webhook/handlers";
import { registerWebhookIpc } from "@main/webhook/ipc";
import { createWebhookReceiver } from "@main/webhook/receiver";
import { installSessionLockdown, installWebContentsHardening } from "@main/window-hardening";
import { createMainWindow, showMainWindow } from "@main/window";

// 在任何視窗建立之前就安裝鎖定。
installWebContentsHardening();

// macOS 可能在 App 還沒準備好時就送來 open-url／open-file（例如從 Finder 的快速動作冷啟動）：
// 先接住，等啟動器準備好再依序處理。
const externalGate = createExternalOpenGate();
app.on("open-url", (event, url) => {
  event.preventDefault();
  externalGate.push({ kind: "url", value: url });
});
app.on("open-file", (event, path) => {
  event.preventDefault();
  externalGate.push({ kind: "file", value: path });
});

const registerAppInfoIpc = (): void => {
  handleIpc(IPC.appInfo, asNoArgs, (): AppInfo => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform
  }));
};

/** 視窗顯示之後才開始輪詢（啟動時間 <2 秒的做法）；視窗一直沒顯示也最晚這個時間點開始。 */
const MONITOR_START_FALLBACK_MS = 3_000;

const bootstrap = (): void => {
  installSessionLockdown();

  let logger: Logger | null = null;
  installProcessGuards({ getLogger: () => logger });

  const db = initDataLayer();
  const log = createLogger(() => db);
  logger = log;
  const vault = initVault(db);
  const git = {
    runGit,
    readVersion: (localPath: string, source: Parameters<typeof readProjectVersion>[0]["source"]) =>
      readProjectVersion({ localPath, source, runGit }),
    now: () => new Date()
  };

  // 上次沒正常結束的規則執行（程式被關掉、當掉）標成 interrupted，不要一直顯示「執行中」。
  markInterruptedExecutions(db, Date.now());

  const ai = createAiService({
    db,
    vault,
    runGit,
    now: Date.now,
    log: (entry) => log.log(entry),
    clients: { anthropic: createAnthropicClient(fetch), openai: createOpenAiClient(fetch) }
  });
  const engine = createRuleRuntime({ db, vault, git, logger: log, ai, onNotificationClick: showMainWindow });

  // 輪詢與 Webhook 共用同一條事件管線，同一次推送不管從哪邊先到都只會處理一次。
  const ingest = createEventPipeline(db, log, {
    onNotificationClick: showMainWindow,
    onNewEvent: [(event, project) => engine.enqueue(event, project)]
  });
  const monitor = createMonitorRuntime(db, vault, ingest, log);
  const webhookReceiver = createWebhookReceiver({
    db,
    vault,
    ingest,
    now: Date.now,
    log: (entry) => log.log(entry),
    onActivity: ({ events }) => emitMonitorChange({ events, status: true })
  });

  const launcher = createLauncherRuntime({
    db,
    logger: log,
    showMainWindow,
    monitor,
    onMonitorChange: (listener) => onMonitorChange(listener),
    externalGate,
    onConfigChanged: backupSoon
  });
  // 設定類資料變動：排程備份，並重建托盤選單（專案、映射可能改了）。
  const onConfigChanged = (): void => {
    backupSoon();
    launcher.refreshTray();
  };

  registerAppInfoIpc();
  registerSecretsIpc(vault, { ai });
  registerAiIpc(ai);
  registerAppIpc(createAppHandlers({ db, monitor, git, log: (entry) => log.log(entry), onConfigChanged }));
  registerRulesIpc(createRulesHandlers({ db, engine, vault, onConfigChanged }));
  registerLauncherIpc(launcher.handlers);
  registerRunIpc(createRunRuntime({ db, logger: log, vault, copySecret: copySecretToClipboard }));
  registerWebhookIpc(
    createWebhookAdminHandlers({ db, vault, receiver: webhookReceiver, copySecret: copySecretToClipboard, now: Date.now, onConfigChanged })
  );
  registerAppSettingsIpc(
    createAppSettingsHandlers({
      db,
      backupDir: getBackupDir(),
      now: Date.now,
      // 未打包（開發模式）登錄的會是 Electron 本體，不是這個 App。
      loginItem: {
        supported: app.isPackaged,
        get: () => app.getLoginItemSettings().openAtLogin,
        set: (enabled) => app.setLoginItemSettings({ openAtLogin: enabled })
      },
      onConfigChanged,
      onRestored: () => {
        monitor.reloadProjects();
        launcher.refreshTray();
      }
    })
  );

  let backgroundServicesStarted = false;
  const startBackgroundServices = (): void => {
    if (backgroundServicesStarted) return;
    backgroundServicesStarted = true;
    monitor.start();
    // 選配功能，預設關閉；使用者開啟過才會在這裡啟動本機接收端。
    void webhookReceiver.apply();
  };

  // 開機登入時只留托盤，不彈出視窗；平常啟動則顯示視窗，並等它畫好之後才開始輪詢。
  if (app.getLoginItemSettings().wasOpenedAtLogin) {
    startBackgroundServices();
  } else {
    createMainWindow().once("ready-to-show", startBackgroundServices);
    setTimeout(startBackgroundServices, MONITOR_START_FALLBACK_MS).unref();
  }

  app.on("will-quit", () => launcher.dispose());
  app.on("before-quit", () => {
    monitor.stop();
    void webhookReceiver.stop();
    closeDataLayer();
  });
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => void showMainWindow());
  void app.whenReady().then(bootstrap);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });

  // 關閉視窗只是銷毀畫面（渲染程序），監視、規則、托盤與快捷鍵都留在主程序裡繼續運作；
  // 要結束請用托盤選單的「結束」或 Cmd+Q。
  app.on("window-all-closed", () => undefined);
}
