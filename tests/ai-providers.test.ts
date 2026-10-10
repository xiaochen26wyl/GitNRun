import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ANTHROPIC_URL,
  OPENAI_URL,
  AiProviderError,
  createAnthropicClient,
  createOpenAiClient,
  type AiFetch
} from "@main/ai/providers";

const KEY = "sk-ant-api03-" + "abcdefghijklmnop";

const scripted = (status: number, body: unknown, options: { jsonError?: boolean; throws?: boolean } = {}) => {
  const requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const fetchFn: AiFetch = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
    if (options.throws) throw new Error(`connect failed for ${url} with ${init.headers["x-api-key"]}`);
    return { status, json: async () => { if (options.jsonError) throw new Error("bad json"); return body; } };
  };
  return { fetchFn, requests };
};

const request = { model: "some-model", system: "SYS", user: "USER", maxTokens: 50 };

describe("Anthropic client", () => {
  it("sends the Messages API request with the key only in the x-api-key header", async () => {
    const t = scripted(200, { content: [{ type: "text", text: "feat: " }, { type: "text", text: "登入" }], usage: { input_tokens: 12, output_tokens: 7 } });
    const response = await createAnthropicClient(t.fetchFn).complete(request, KEY);

    assert.deepEqual(response, { text: "feat: 登入", inputTokens: 12, outputTokens: 7 });
    const sent = t.requests[0];
    assert.equal(sent?.url, ANTHROPIC_URL);
    assert.equal(sent?.headers["x-api-key"], KEY);
    assert.equal(sent?.headers["anthropic-version"], "2023-06-01");
    assert.deepEqual(sent?.body, { model: "some-model", max_tokens: 50, system: "SYS", messages: [{ role: "user", content: "USER" }] });
    assert.ok(!JSON.stringify(sent?.body).includes(KEY), "the key is never part of the body");
  });

  it("ignores non-text blocks and tolerates a missing usage section", async () => {
    const t = scripted(200, { content: [{ type: "tool_use" }, { type: "text", text: "ok" }] });
    assert.deepEqual(await createAnthropicClient(t.fetchFn).complete(request, KEY), { text: "ok", inputTokens: null, outputTokens: null });
  });

  it("maps HTTP statuses to error kinds", async () => {
    const kinds: Array<[number, string]> = [[401, "auth"], [403, "auth"], [429, "rate-limited"], [400, "invalid"], [404, "invalid"], [500, "unavailable"], [529, "unavailable"]];
    for (const [status, kind] of kinds) {
      await assert.rejects(
        createAnthropicClient(scripted(status, { error: { message: "echoes your prompt: USER" } }).fetchFn).complete(request, KEY),
        (error) => error instanceof AiProviderError && error.kind === kind && !error.message.includes("USER"),
        String(status)
      );
    }
  });

  it("treats a network failure as unavailable without leaking the URL or key", async () => {
    await assert.rejects(createAnthropicClient(scripted(200, {}, { throws: true }).fetchFn).complete(request, KEY), (error) => {
      assert.ok(error instanceof AiProviderError);
      assert.equal(error.kind, "unavailable");
      assert.ok(!error.message.includes(KEY));
      return true;
    });
  });

  it("rejects an unreadable or unexpected response body", async () => {
    await assert.rejects(createAnthropicClient(scripted(200, {}, { jsonError: true }).fetchFn).complete(request, KEY), { kind: "invalid" });
    await assert.rejects(createAnthropicClient(scripted(200, { nope: true }).fetchFn).complete(request, KEY), { kind: "invalid" });
  });
});

describe("OpenAI client", () => {
  it("sends a chat completion with the key as a bearer token", async () => {
    const t = scripted(200, { choices: [{ message: { content: "fix: 修正" } }], usage: { prompt_tokens: 20, completion_tokens: 5 } });
    const response = await createOpenAiClient(t.fetchFn).complete(request, "sk-proj-abcdefghijklmnopqrstuvwxyz");

    assert.deepEqual(response, { text: "fix: 修正", inputTokens: 20, outputTokens: 5 });
    const sent = t.requests[0];
    assert.equal(sent?.url, OPENAI_URL);
    assert.equal(sent?.headers.Authorization, "Bearer sk-proj-abcdefghijklmnopqrstuvwxyz");
    assert.deepEqual(sent?.body, {
      model: "some-model",
      max_completion_tokens: 50,
      messages: [{ role: "system", content: "SYS" }, { role: "user", content: "USER" }]
    });
  });

  it("maps errors the same way and rejects malformed bodies", async () => {
    await assert.rejects(createOpenAiClient(scripted(401, {}).fetchFn).complete(request, "k"), { kind: "auth" });
    await assert.rejects(createOpenAiClient(scripted(429, {}).fetchFn).complete(request, "k"), { kind: "rate-limited" });
    await assert.rejects(createOpenAiClient(scripted(503, {}).fetchFn).complete(request, "k"), { kind: "unavailable" });
    await assert.rejects(createOpenAiClient(scripted(200, { choices: [] }).fetchFn).complete(request, "k"), { kind: "invalid" });
    await assert.rejects(createOpenAiClient(scripted(200, { choices: [{ message: { content: null } }] }).fetchFn).complete(request, "k"), { kind: "invalid" });
  });
});
