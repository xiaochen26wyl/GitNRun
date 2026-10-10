import { useCallback, useEffect, useState } from "react";
import {
  AI_PROVIDERS,
  AI_PROVIDER_LABELS,
  DEFAULT_AI_SETTINGS,
  DEFAULT_PROMPTS,
  type AiPrompts,
  type AiProvider,
  type AiSettings,
  type AiUsage
} from "@shared/ai";
import { errorMessage } from "@shared/format";
import { linesToList, listToLines } from "@shared/rule-defaults";

const PROMPT_LABELS: Record<keyof AiPrompts, string> = {
  commit: "Commit 訊息",
  summary: "事件摘要",
  suggest: "推送建議",
  conflict: "衝突說明"
};

const PROMPT_VARIABLES: Record<keyof AiPrompts, string> = {
  commit: "{project} {branch} {files} {diff}",
  summary: "{project} {branch} {pusher} {commits} {files}",
  suggest: "{project} {branch} {branchStatus} {fileCount} {commits} {files}",
  conflict: "{project} {head} {against} {files} {messages}"
};

/**
 * AI 設定。金鑰在上方的「金鑰」區塊設定；這裡管模型、送出內容的限制、成本控制與提示詞。
 * 注意：啟用 AI 後，程式碼差異會送到你選的供應商；每個專案要在「專案」分頁各自允許才會真的送出。
 */
export const AiPanel = () => {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [usage, setUsage] = useState<AiUsage | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refreshUsage = useCallback(() => {
    void window.gitNRun.getAiUsage().then(setUsage);
  }, []);

  useEffect(() => {
    void window.gitNRun.getAiSettings().then(setSettings);
    refreshUsage();
  }, [refreshUsage]);

  if (!settings) return null;

  const update = (patch: Partial<AiSettings>) => setSettings({ ...settings, ...patch });
  const num = (value: string): number => Number(value);

  const save = async () => {
    setMessage("");
    setError("");
    try {
      setSettings(await window.gitNRun.saveAiSettings(settings));
      setMessage("已儲存");
    } catch (saveError) {
      setError(errorMessage(saveError));
    }
  };

  return (
    <section className="panel">
      <h2>AI 助手</h2>
      <p className="muted">
        啟用後，commit 訊息的程式碼差異（排除清單上的檔案不送、疑似密鑰會遮蔽）與事件的 commit 訊息、檔名會送到你選的供應商。
        每個專案要在「專案」分頁各自允許才會送出；沒有允許、沒有金鑰、額度用完或離線時，會自動改用本機規則。
      </p>

      <div className="form-grid">
        <label className="field">
          供應商
          <select value={settings.provider} onChange={(event) => update({ provider: event.target.value as AiProvider })}>
            {AI_PROVIDERS.map((provider) => (
              <option key={provider} value={provider}>
                {AI_PROVIDER_LABELS[provider]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Anthropic 快速模型（commit 訊息、摘要）
          <input className="mono" value={settings.anthropicFastModel} onChange={(event) => update({ anthropicFastModel: event.target.value })} />
        </label>
        <label className="field">
          Anthropic 進階模型（推送建議、衝突說明）
          <input className="mono" value={settings.anthropicDeepModel} onChange={(event) => update({ anthropicDeepModel: event.target.value })} />
        </label>
        <label className="field">
          OpenAI 模型（自行填入）
          <input className="mono" value={settings.openaiModel} placeholder="選 OpenAI 時必填" onChange={(event) => update({ openaiModel: event.target.value })} />
        </label>
        <label className="field">
          差異內容上限（位元組）
          <input type="number" value={settings.maxDiffBytes} onChange={(event) => update({ maxDiffBytes: num(event.target.value) })} />
        </label>
        <label className="field">
          每分鐘最多呼叫次數
          <input type="number" value={settings.ratePerMinute} onChange={(event) => update({ ratePerMinute: num(event.target.value) })} />
        </label>
        <label className="field">
          每日最多呼叫次數
          <input type="number" value={settings.dailyLimit} onChange={(event) => update({ dailyLimit: num(event.target.value) })} />
        </label>
        <label className="field">
          合併事件的時間窗（秒，0 = 不合併）
          <input type="number" value={settings.batchWindowSec} onChange={(event) => update({ batchWindowSec: num(event.target.value) })} />
        </label>
        <label className="field">
          快取保留時間（小時）
          <input type="number" value={settings.cacheTtlHours} onChange={(event) => update({ cacheTtlHours: num(event.target.value) })} />
        </label>
      </div>

      <label className="field">
        不送出內容的檔案（每行一個；沒有 / 的樣式比對檔名）
        <textarea className="mono" rows={6} value={listToLines(settings.excludeGlobs)} onChange={(event) => update({ excludeGlobs: linesToList(event.target.value) })} spellCheck={false} />
      </label>
      <div>
        <button type="button" onClick={() => update({ excludeGlobs: [...DEFAULT_AI_SETTINGS.excludeGlobs] })}>
          還原預設排除清單
        </button>
      </div>

      <details>
        <summary>提示詞模板</summary>
        {(Object.keys(PROMPT_LABELS) as Array<keyof AiPrompts>).map((key) => (
          <label key={key} className="field">
            {PROMPT_LABELS[key]}（可用變數：<span className="mono">{PROMPT_VARIABLES[key]}</span>）
            <textarea rows={8} value={settings.prompts[key]} onChange={(event) => update({ prompts: { ...settings.prompts, [key]: event.target.value } })} />
            <span>
              <button type="button" onClick={() => update({ prompts: { ...settings.prompts, [key]: DEFAULT_PROMPTS[key] } })}>
                還原預設
              </button>
            </span>
          </label>
        ))}
      </details>

      <div className="row-actions">
        <button type="button" onClick={() => void save()}>
          儲存 AI 設定
        </button>
        <button type="button" onClick={refreshUsage}>
          重新整理用量
        </button>
      </div>
      {message ? <p className="ok">{message}</p> : null}
      {error ? <p className="warn pre-line">{error}</p> : null}

      {usage ? (
        <p className="muted">
          最近 24 小時：呼叫 {usage.callsToday}／{usage.dailyLimit} 次，快取命中 {usage.cacheHitsToday} 次，用量 {usage.inputTokensToday} 輸入／{usage.outputTokensToday} 輸出 tokens；
          最近一分鐘 {usage.callsLastMinute}／{usage.ratePerMinute} 次。
        </p>
      ) : null}
    </section>
  );
};
