import { IPC } from "@shared/ipc";
import { registerAiIpc } from "@main/ai/ipc";
import { createAnthropicClient, createOpenAiClient } from "@main/ai/providers";
import { createAiService } from "@main/ai/service";
import { createAppHandlers } from "@main/app-handlers";
import { registerAppIpc } from "@main/app-ipc";
import { createAppSettingsHandlers } from "@main/app-settings";
import { registerAppSettingsIpc } from "@main/app-settings-ipc";
import { registerBrandIpc } from "@main/brand/ipc";
import { createBrandRuntime } from "@main/brand/runtime";
import { copySecretToClipboard, copySecretToClipboardChecked } from "@main/clipboard-secret";
import { closeDataLayer, getBackupDir, initDataLayer } from "@main/data-layer";
import { markInterruptedExecutions } from "@main/db/rule-executions-repo";
import { readDocumentRoot } from "@main/documents/handlers";
import { registerDocumentIpc } from "@main/documents/ipc";
import { createDocumentRuntime, findRepoFolders } from "@main/documents/runtime";
import { createGitLiteHandlers } from "@main/git-lite/handlers";
import { registerGitLiteIpc } from "@main/git-lite/ipc";
import { runGit } from "@main/git/run-git";
import { readProjectVersion } from "@main/git/version-source";
import { handleIpc } from "@main/ipc";
import { asNoArgs, asNotifyShowArgs } from "@main/ipc-validation";
import type { ExternalOpenGate } from "@main/launcher/external";
import { registerLauncherIpc } from "@main/launcher/ipc";
import { createLauncherRuntime } from "@main/launcher/runtime";
import { registerRunIpc } from "@main/run/ipc";
import { createRunRuntime } from "@main/run/runtime";
import { createLogger, type Logger } from "@main/logger";
import { createEventPipeline, createMonitorRuntime, emitMonitorChange } from "@main/monitor/runtime";
import { native } from "@main/native/bridge";
import { showDesktopNotification } from "@main/notifier";
import { installProcessGuards } from "@main/reliability/process-guards";
import { createRulesHandlers } from "@main/rules/handlers";
import { registerRulesIpc } from "@main/rules/ipc";
import { createRuleRuntime } from "@main/rules/runtime";
import { registerSecretsIpc } from "@main/secrets-ipc";
import { initVault } from "@main/vault/runtime";
import type { SecretCipher } from "@main/vault/vault";
import { createWebhookAdminHandlers } from "@main/webhook/handlers";
import { registerWebhookIpc } from "@main/webhook/ipc";
import { createWebhookReceiver } from "@main/webhook/receiver";

/**
 * 與外殼無關的啟動流程：資料層、保險庫、監視器、規則引擎、啟動器，
 * 以及全部 IPC 通道的註冊。呼叫前必須先用 setNative() 裝好外殼。
 * 視窗、通道的實際掛接（Tauri 的 sidecar 連線）由外殼負責。
 */

export interface CoreOptions {
  /** 外部（網址、Dock）送來的開啟請求收件匣；外殼在核心啟動前就要開始往裡放。 */
  externalGate: ExternalOpenGate;
  /** 加密方式由外殼決定（Keychain 金鑰的 AES-GCM）。 */
  cipher: SecretCipher;
}

export interface Core {
  logger: Logger;
  /** 放掉全域快捷鍵（程式要結束之前）。 */
  releaseShortcuts: () => void;
  /** 停止監視器與 Webhook、關閉資料庫。 */
  stop: () => void;
}

const registerAppInfoIpc = (): void => {
  handleIpc(IPC.appInfo, asNoArgs, () => native().appInfo());
};

/** renderer 主動觸發的系統通知（例如變更檔案數跨過門檻），點擊時聚焦主視窗。 */
const registerNotifyIpc = (onNotificationClick: () => void): void => {
  handleIpc(IPC.notifyShow, asNotifyShowArgs, (title, body) => {
    showDesktopNotification(title, body, onNotificationClick);
  });
};

export const startCore = (options: CoreOptions): Core => {
  let logger: Logger | null = null;
  installProcessGuards({ getLogger: () => logger });

  const db = initDataLayer();
  const log = createLogger(() => db);
  logger = log;
  const vault = initVault(db, options.cipher);
  const git = {
    runGit,
    readVersion: (localPath: string, source: Parameters<typeof readProjectVersion>[0]["source"]) =>
      readProjectVersion({ localPath, source, runGit }),
    now: () => new Date()
  };

  // 上次沒正常結束的規則執行（程式被關掉、當掉）標成 interrupted，不要一直顯示「執行中」。
  markInterruptedExecutions(db, Date.now());

  const onNotificationClick = (): void => native().focusMainWindow();

  const ai = createAiService({
    db,
    vault,
    runGit,
    now: Date.now,
    log: (entry) => log.log(entry),
    clients: { anthropic: createAnthropicClient(fetch), openai: createOpenAiClient(fetch) }
  });
  const engine = createRuleRuntime({ db, vault, git, logger: log, ai, onNotificationClick });

  // 輪詢與 Webhook 共用同一條事件管線，同一次推送不管從哪邊先到都只會處理一次。
  const ingest = createEventPipeline(db, log, {
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

  // 設定類資料變動的回呼：備份改為每天 22:00 一次，不再隨異動觸發；保留介面讓各 handler 不必跟著改。
  const onConfigChanged = (): void => undefined;

  const launcher = createLauncherRuntime({
    db,
    logger: log,
    externalGate: options.externalGate,
    onConfigChanged
  });

  registerAppInfoIpc();
  registerNotifyIpc(onNotificationClick);
  registerSecretsIpc(vault, { ai });
  registerAiIpc(ai);
  registerAppIpc(createAppHandlers({ db, monitor, git, log: (entry) => log.log(entry), onConfigChanged }));
  registerRulesIpc(createRulesHandlers({ db, engine, vault, onConfigChanged }));
  registerLauncherIpc(launcher.handlers);
  registerRunIpc(createRunRuntime({ db, logger: log, vault, copySecret: copySecretToClipboardChecked }));
  registerDocumentIpc(createDocumentRuntime({ db, now: Date.now, onConfigChanged }));
  registerBrandIpc(createBrandRuntime({ db }));
  registerGitLiteIpc(
    createGitLiteHandlers({
      db,
      runGit,
      vault,
      fetchFn: fetch,
      discoverRepoFolders: () => {
        const root = readDocumentRoot(db);
        return root === "" ? [] : findRepoFolders(root);
      }
    })
  );
  registerWebhookIpc(
    createWebhookAdminHandlers({ db, vault, receiver: webhookReceiver, copySecret: copySecretToClipboard, now: Date.now, onConfigChanged })
  );
  registerAppSettingsIpc(
    createAppSettingsHandlers({
      db,
      backupDir: getBackupDir(),
      now: Date.now,
      onConfigChanged,
      onRestored: () => {
        monitor.reloadProjects();
      }
    })
  );

  return {
    logger: log,
    releaseShortcuts: () => void launcher.dispose(),
    stop: () => {
      monitor.stop();
      void webhookReceiver.stop();
      closeDataLayer();
    }
  };
};
