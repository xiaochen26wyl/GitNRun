import { useCallback, useEffect, useState } from "react";
import { errorMessage, formatDateTime } from "@shared/format";
import type { Project } from "@shared/projects";
import { useProjectHead } from "./hooks";
import { DEFAULT_WEBHOOK_PORT, WEBHOOK_HOST, type ProjectWebhookInfo, type WebhookSettings, type WebhookStatus } from "@shared/webhook";

/**
 * Webhook（選配）。預設用輪詢就夠了；Webhook 能把偵測時間縮到 1 秒內，並拿到確切的推送者，
 * 但 GitHub 必須連得到你的電腦，所以要自備隧道（ngrok、cloudflared），本機接收端只綁 127.0.0.1。
 */
export const WebhookPanel = () => {
  const [settings, setSettings] = useState<WebhookSettings | null>(null);
  const [status, setStatus] = useState<WebhookStatus | null>(null);
  const [infos, setInfos] = useState<ProjectWebhookInfo[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const headProps = useProjectHead();

  const refresh = useCallback(() => {
    void window.gitNRun.getWebhookStatus().then(setStatus);
    void window.gitNRun.getWebhookProjects().then(setInfos);
    void window.gitNRun.listProjects().then(setProjects);
  }, []);

  useEffect(() => {
    void window.gitNRun.getWebhookSettings().then(setSettings);
    refresh();
  }, [refresh]);

  if (!settings) return null;

  const guard = async (action: () => Promise<void>, success: string) => {
    setMessage("");
    setError("");
    try {
      await action();
      setMessage(success);
      refresh();
    } catch (actionError) {
      setError(errorMessage(actionError));
    }
  };

  const projectName = (id: number): string => projects.find((project) => project.id === id)?.name ?? `專案 ${id}`;

  return (
    <section className="panel">
      <h2>Webhook（選配）</h2>
      <p className="muted">
        預設的輪詢不需要任何設定。想要接近即時的通知與確切的推送者，才需要開啟：GitHub 要能連到你的電腦，所以你得自備隧道（例如{" "}
        <span className="mono">ngrok http {settings.port}</span>），本機接收端只監聽 {WEBHOOK_HOST}，每個請求都要通過簽章驗證。
      </p>

      <div className="form-grid">
        <label className="inline-check">
          <input type="checkbox" checked={settings.enabled} onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })} />
          啟用本機接收端
        </label>
        <label className="field">
          連接埠
          <input type="number" value={settings.port} placeholder={String(DEFAULT_WEBHOOK_PORT)} onChange={(event) => setSettings({ ...settings, port: Number(event.target.value) })} />
        </label>
        <label className="field wide">
          隧道的公開網址（https，只用來顯示 Payload URL；免費版 ngrok 每次重啟網址會變，要重新貼到 GitHub）
          <input
            className="mono"
            value={settings.publicBaseUrl ?? ""}
            placeholder="https://xxxx.ngrok-free.app"
            onChange={(event) => setSettings({ ...settings, publicBaseUrl: event.target.value.trim() === "" ? null : event.target.value })}
          />
        </label>
      </div>
      <div className="row-actions">
        <button type="button" onClick={() => void guard(async () => setSettings(await window.gitNRun.saveWebhookSettings(settings)), "已儲存")}>
          儲存
        </button>
        {status ? (
          <span className={status.error ? "warn" : status.listening ? "ok" : "muted"}>
            {status.error ? `無法啟動：${status.error}` : status.listening ? `已在 ${WEBHOOK_HOST}:${status.port} 接收中` : status.enabled ? "啟動中…" : "未啟用"}
          </span>
        ) : null}
      </div>
      {message ? <p className="ok">{message}</p> : null}
      {error ? <p className="warn pre-line">{error}</p> : null}

      <h3>各專案的設定</h3>
      <p className="muted">
        先到「專案」把要用 Webhook 的專案切到「Webhook」或「輪詢＋Webhook」。然後在 GitHub 的 repo → Settings → Webhooks → Add webhook：
        Payload URL 貼下面的網址，Content type 選 <span className="mono">application/json</span>，Secret 貼上複製好的值，Events 選 Just the push event。
      </p>
      {infos.length === 0 ? <p className="muted">目前沒有專案使用 Webhook。</p> : null}
      <ul className="project-list">
        {infos.map((info) => (
          <li key={info.projectId} className="project-row">
            <div {...headProps(projects.find((project) => project.id === info.projectId)?.localPath)}>
              <strong>{projectName(info.projectId)}</strong>
              <span className="muted">{info.lastReceivedAt ? `最近收到：${formatDateTime(info.lastReceivedAt)}` : "尚未收到過"}</span>
            </div>
            <div className="mono">{info.payloadUrl ?? <span className="muted">先填上方的公開網址，才會顯示 Payload URL</span>}</div>
            <div className="row-actions">
              {info.payloadUrl ? (
                <button type="button" onClick={() => void guard(() => window.gitNRun.copyText(info.payloadUrl as string), "已複製 Payload URL")}>
                  複製網址
                </button>
              ) : null}
              <button
                type="button"
                onClick={() =>
                  void guard(
                    async () => void (await window.gitNRun.generateWebhookSecret(info.projectId)),
                    "已產生新的 secret 並複製到剪貼簿（60 秒後自動清除），請現在貼到 GitHub 的 Secret 欄位。舊的 secret 已失效。"
                  )
                }
              >
                {info.secretConfigured ? "重新產生 secret（複製到剪貼簿）" : "產生 secret（複製到剪貼簿）"}
              </button>
              {info.secretConfigured ? (
                <button type="button" onClick={() => void guard(() => window.gitNRun.removeWebhookSecret(info.projectId), "已移除 secret，這個專案不會再接受 Webhook")}>
                  移除 secret
                </button>
              ) : (
                <span className="warn">尚未設定 secret，收到的請求都會被拒絕</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
};
