import type { AiPurpose, AiUsage } from "@shared/ai";
import type { Db } from "@main/db/database";

export type AiCallStatus = "ok" | "error" | "invalid";

export interface AiCallRecord {
  ts: number;
  projectId: number | null;
  provider: string;
  model: string;
  purpose: AiPurpose;
  inputHash: string;
  cacheHit: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  status: AiCallStatus;
  responseText: string | null;
}

export const recordAiCall = (db: Db, call: AiCallRecord): void => {
  db.prepare(
    `INSERT INTO ai_calls (ts, project_id, provider, model, purpose, input_hash, cache_hit, input_tokens, output_tokens, status, response_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    call.ts,
    call.projectId,
    call.provider,
    call.model,
    call.purpose,
    call.inputHash,
    call.cacheHit ? 1 : 0,
    call.inputTokens,
    call.outputTokens,
    call.status,
    call.responseText
  );
};

/** 同樣的輸入（供應商＋模型＋提示詞）在保留期限內成功過，就直接用上次的回覆。 */
export const findCachedResponse = (db: Db, inputHash: string, model: string, since: number): string | null => {
  const row = db
    .prepare(
      `SELECT response_text FROM ai_calls
       WHERE input_hash = ? AND model = ? AND status = 'ok' AND cache_hit = 0 AND ts >= ?
       ORDER BY ts DESC LIMIT 1`
    )
    .get(inputHash, model, since);
  return typeof row?.response_text === "string" ? row.response_text : null;
};

/** 真正打出去的呼叫次數（不含快取命中）。成功與失敗都算，才能擋住失控的重試。 */
export const countRealCalls = (db: Db, since: number): number =>
  Number(db.prepare("SELECT COUNT(*) AS n FROM ai_calls WHERE cache_hit = 0 AND ts >= ?").get(since)?.n);

export const readUsage = (db: Db, now: number, limits: { dailyLimit: number; ratePerMinute: number }): AiUsage => {
  const dayStart = now - 24 * 60 * 60 * 1000;
  const totals = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN cache_hit = 0 THEN 1 ELSE 0 END), 0) AS calls,
         COALESCE(SUM(CASE WHEN cache_hit = 1 THEN 1 ELSE 0 END), 0) AS hits,
         COALESCE(SUM(input_tokens), 0) AS input,
         COALESCE(SUM(output_tokens), 0) AS output
       FROM ai_calls WHERE ts >= ?`
    )
    .get(dayStart);
  return {
    callsToday: Number(totals?.calls),
    dailyLimit: limits.dailyLimit,
    callsLastMinute: countRealCalls(db, now - 60_000),
    ratePerMinute: limits.ratePerMinute,
    cacheHitsToday: Number(totals?.hits),
    inputTokensToday: Number(totals?.input),
    outputTokensToday: Number(totals?.output)
  };
};
