import { beforeEach, describe, expect, it, vi } from "vitest";
import { sanitizeCustomApiRequest } from "../../open-sse/utils/customApiPrivacy.js";
import { isClaudeCodeRuntimeEnabled, shouldUseClaudeCodeRuntime } from "../../open-sse/shared/claudeCode/policy.js";

const { outbound, refresh } = vi.hoisted(() => ({ outbound: vi.fn(), refresh: vi.fn() }));
vi.mock("../../open-sse/utils/customApiFetch.js", () => ({ fetchCustomApi: (...args) => outbound(...args) }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn(), default: vi.fn() }));
vi.mock("../../open-sse/services/tokenRefresh.js", () => ({ refreshWithRetry: (...args) => refresh(...args) }));

import { BaseExecutor } from "../../open-sse/executors/base.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";
import { handleEmbeddingsCore } from "../../open-sse/handlers/embeddingsCore.js";
import { handleTtsCore } from "../../open-sse/handlers/ttsCore.js";
import { handleSttCore } from "../../open-sse/handlers/sttCore.js";

const provider = "openai-compatible-private";
const credentials = (extra = {}) => ({
  apiKey: "required-api-key",
  providerSpecificData: { baseUrl: "https://custom.test/v1", anonymizeRequests: true, ...extra },
});
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  outbound.mockReset();
  refresh.mockReset().mockResolvedValue(null);
});

describe("custom API privacy policy", () => {
  it.each([provider, "anthropic-compatible-private", "custom-embedding-private"])("anonymizes %s only when explicitly enabled", (id) => {
    const request = { url: "https://custom.test/api", headers: { "x-session-id": "sid" }, body: { user: "alice", messages: [] } };
    expect(sanitizeCustomApiRequest(id, credentials(), request).body).toEqual({ messages: [] });
    for (const flag of [undefined, false, "true", 1]) {
      const unchanged = sanitizeCustomApiRequest(id, credentials({ anonymizeRequests: flag }), request);
      expect(unchanged.headers).toBe(request.headers);
      expect(unchanged.body).toBe(request.body);
    }
    expect(sanitizeCustomApiRequest("openai", credentials(), request).body).toBe(request.body);
  });

  it("removes mixed-case identity/fingerprint headers while retaining auth and feature headers", () => {
    const headers = {
      Authorization: "Bearer key", "X-API-Key": "key", "anthropic-version": "2023-06-01",
      "Anthropic-Beta": "context-management-2025-06-27", "Content-Type": "application/json", Accept: "text/event-stream",
      "User-Agent": "claude-cli/2.1 device", "X-Claude-Code-Session-Id": "sid", "X-Mavis-Session-Id": "sid",
      "oAi-DeViCe-Id": "device", "X-Request-ID": "rid", "X-User-Identifier": "alice",
      "X-User-Email": "alice@example.test", "HTTP-Referer": "https://private.test",
      "X-Forwarded-For": "192.0.2.1", "CF-Connecting-IP": "192.0.2.1", Forwarded: "for=192.0.2.1",
      Cookie: "identity=secret", Referer: "https://private.test", Origin: "https://private.test", "X-App": "cli",
      Traceparent: "trace", Tracestate: "trace", Baggage: "user=alice", "X-Stainless-OS": "private-os",
      "sec-ch-ua-platform": "private-os", "x-9router-runtime-hop": "router-id", "X-Feature-Mode": "fast",
    };
    const result = sanitizeCustomApiRequest(provider, credentials(), { url: "https://custom.test", headers, body: {} });
    expect(result.headers).toEqual({
      Authorization: "Bearer key", "X-API-Key": "key", "anthropic-version": "2023-06-01",
      "Anthropic-Beta": "context-management-2025-06-27", "Content-Type": "application/json", Accept: "text/event-stream",
      "X-Feature-Mode": "fast",
    });
    expect(headers.Cookie).toBe("identity=secret");
    expect(sanitizeCustomApiRequest(provider, credentials(), { headers: new Headers(headers) }).headers).toEqual(
      Object.fromEntries(new Headers(result.headers).entries()),
    );
    expect(sanitizeCustomApiRequest(provider, credentials(), { headers: Object.entries(headers) }).headers).toEqual(result.headers);
  });

  it("removes request IDs and arbitrary metadata without editing messages, tool correlation, schema or media", () => {
    const body = {
      model: "model", user: "alice", userId: "alice", session_id: "session", deviceID: "device", request_id: "req",
      safety_identifier: "safety", prompt_cache_key: "cache", cacheKey: "cache", client_metadata: { anything: "identity" },
      metadata: { user_id: "alice", customLabel: "private label" },
      messages: [{ role: "assistant", tool_calls: [{ id: "tool-1", type: "function", function: { name: "lookup", arguments: '{"session_id":"functional"}' } }] },
        { role: "tool", tool_call_id: "tool-1", content: "user alice" },
        { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }] }],
      tools: [{ name: "lookup", input_schema: { type: "object", properties: { user_id: { type: "string" } } } }],
      response_format: { type: "json_schema", json_schema: { schema: { properties: { session_id: { type: "string" } } } } },
      previous_response_id: "resp_context", conversation: "conv_context",
    };
    const result = sanitizeCustomApiRequest(provider, credentials(), { body }).body;
    expect(result).toEqual({
      model: body.model, messages: body.messages, tools: body.tools, response_format: body.response_format,
      previous_response_id: "resp_context", conversation: "conv_context",
    });
    expect(result.messages).toBe(body.messages);
    expect(result.tools).toBe(body.tools);
    expect(body.session_id).toBe("session");
    expect(body.metadata.customLabel).toBe("private label");
    const nullPrototype = Object.assign(Object.create(null), { user_id: "alice", model: "model" });
    expect(sanitizeCustomApiRequest(provider, credentials(), { body: nullPrototype }).body).toEqual({ model: "model" });
  });

  it("removes query tracking identifiers while preserving endpoint path, authentication and protocol query parameters", () => {
    const url = "https://custom.test/account-route?session_id=s1&session_id=s2&userId=alice&api_key=key&api-version=v2&utm_source=client&beta=true";
    const cleaned = new URL(sanitizeCustomApiRequest(provider, credentials(), { url }).url);
    expect(cleaned.pathname).toBe("/account-route");
    expect(Object.fromEntries(cleaned.searchParams)).toEqual({ api_key: "key", "api-version": "v2", beta: "true" });
  });

  it("anonymizes multipart fields and audio filename while preserving the file bytes and MIME type", async () => {
    const form = new FormData();
    form.append("file", new Blob(["audio bytes"], { type: "audio/wav" }), "alice-private-session.wav");
    form.append("model", "whisper");
    form.append("session_id", "session");
    const cleaned = sanitizeCustomApiRequest(provider, credentials(), { body: form }).body;
    expect(cleaned.get("session_id")).toBeNull();
    expect(cleaned.get("model")).toBe("whisper");
    expect(cleaned.get("file").name).toBe("audio.wav");
    expect(cleaned.get("file").type).toBe("audio/wav");
    expect(await cleaned.get("file").text()).toBe("audio bytes");
    expect(form.get("file").name).toBe("alice-private-session.wav");
  });
});

describe("custom API outbound boundaries", () => {
  it("sanitizes regenerated body/headers after user overrides on every retry", async () => {
    const executor = new BaseExecutor(provider, { baseUrl: "https://custom.test/api", retry: { 502: { attempts: 1, delayMs: 0 } } });
    executor.transformRequest = (_model, body) => ({ ...body, session_id: "generated-session", metadata: { generated: "identity" } });
    executor.buildHeaders = () => ({ Authorization: "Bearer key", "x-session-id": "generated-session" });
    const firstResponse = jsonResponse({}, 502);
    const cancel = vi.spyOn(firstResponse.body, "cancel");
    outbound.mockResolvedValueOnce(firstResponse).mockResolvedValueOnce(jsonResponse({}));
    const body = { model: "model", messages: [{ role: "user", content: "hello" }], safety_identifier: "client" };
    const result = await executor.execute({
      model: "model", body, stream: false, credentials: credentials(),
      providerOverrides: { headers: { "X-Session-ID": "override-session", "USER-AGENT": "client-fingerprint", "X-Feature": "enabled" } },
    });
    expect(outbound).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(1);
    for (const [id, creds, url, options] of outbound.mock.calls) {
      expect(id).toBe(provider);
      expect(creds.providerSpecificData.anonymizeRequests).toBe(true);
      expect(url).toBe("https://custom.test/v1/chat/completions");
      expect(options.headers).toEqual({ Authorization: "Bearer key", "X-Feature": "enabled" });
      expect(JSON.parse(options.body)).toEqual({ model: "model", messages: body.messages });
    }
    expect(result.headers).toEqual({ Authorization: "Bearer key", "X-Feature": "enabled" });
    expect(result.transformedBody).toEqual({ model: "model", messages: body.messages });
    expect(body.safety_identifier).toBe("client");
  });

  it.each(["https://api.anthropic.com/v1", "https://gateway.test/v1"])("removes generated Claude CLI/session identity for %s and retains Anthropic auth/protocol", async (baseUrl) => {
    const executor = new DefaultExecutor("anthropic-compatible-private");
    executor.config = { ...executor.config, headers: { "User-Agent": "claude-cli/2.1.0", "x-app": "cli" } };
    outbound.mockResolvedValue(jsonResponse({}));
    await executor.execute({
      model: "claude-sonnet-4-6", body: { model: "claude-sonnet-4-6", messages: [], metadata: { user_id: "alice" } },
      stream: true, credentials: credentials({ baseUrl }),
    });
    const options = outbound.mock.calls[0][3];
    expect(new Headers(options.headers).get("user-agent")).toBeNull();
    expect(new Headers(options.headers).get("x-claude-code-session-id")).toBeNull();
    expect(new Headers(options.headers).get("x-api-key")).toBe("required-api-key");
    expect(new Headers(options.headers).get("anthropic-version")).toBeTruthy();
    expect(new Headers(options.headers).get("anthropic-beta")).toBeTruthy();
    expect(JSON.parse(options.body).metadata).toBeUndefined();
  });

  it("anonymizes image requests including authentication retry", async () => {
    outbound.mockResolvedValueOnce(jsonResponse({}, 401)).mockResolvedValueOnce(jsonResponse({ created: 1, data: [{ b64_json: "aW1hZ2U=" }] }));
    refresh.mockResolvedValue({ apiKey: "refreshed-key" });
    const result = await handleImageGenerationCore({
      modelInfo: { provider, model: "image-model" }, credentials: credentials(),
      body: { prompt: "a cat", user: "alice", session_id: "private-session", metadata: { arbitrary: "secret" } },
    });
    expect(result.success).toBe(true);
    expect(outbound).toHaveBeenCalledTimes(2);
    for (const call of outbound.mock.calls) expect(JSON.parse(call[3].body)).toEqual({ prompt: "a cat", model: "image-model" });
    expect(outbound.mock.calls[1][3].headers.Authorization).toBe("Bearer refreshed-key");
  });

  it("sends custom embedding requests through the custom transport with private URL parameters removed", async () => {
    outbound.mockResolvedValue(jsonResponse({ object: "list", data: [{ embedding: [1] }], usage: {} }));
    const result = await handleEmbeddingsCore({
      modelInfo: { provider: "custom-embedding-private", model: "embedding-model" },
      credentials: credentials({ baseUrl: "https://custom.test/v1?session_id=private" }), body: { input: "hello", user: "alice" },
    });
    expect(result.success).toBe(true);
    expect(outbound.mock.calls[0][0]).toBe("custom-embedding-private");
    expect(new URL(outbound.mock.calls[0][2]).searchParams.has("session_id")).toBe(false);
    expect(JSON.parse(outbound.mock.calls[0][3].body)).toEqual({ model: "embedding-model", input: "hello", encoding_format: "float" });
  });

  it("routes custom speech through the custom transport and preserves text and voice", async () => {
    outbound.mockResolvedValue(new Response("audio", { headers: { "content-type": "audio/mpeg" } }));
    const result = await handleTtsCore({ provider, model: "tts-model", input: "hello", voice: "alloy", credentials: credentials() });
    expect(result.success).toBe(true);
    expect(outbound.mock.calls[0][0]).toBe(provider);
    expect(JSON.parse(outbound.mock.calls[0][3].body)).toEqual({ model: "tts-model", input: "hello", voice: "alloy" });
    expect(outbound.mock.calls[0][3].headers.Authorization).toBe("Bearer required-api-key");
  });

  it("routes custom transcription through the custom transport and anonymizes the audio filename", async () => {
    const form = new FormData();
    form.append("file", new Blob(["audio"], { type: "audio/wav" }), "alice-recording.wav");
    form.append("session_id", "private");
    outbound.mockResolvedValue(jsonResponse({ text: "hello" }));
    const result = await handleSttCore({
      provider, model: "whisper", formData: form, credentials: credentials(),
      sttConfig: { baseUrl: "https://custom.test/audio", authType: "apiKey", authHeader: "bearer", format: "openai" },
    });
    expect(result.success).toBe(true);
    const call = outbound.mock.calls[0];
    expect(call[0]).toBe(provider);
    expect(call[3].body.get("file").name).toBe("audio.wav");
    expect(call[3].body.get("session_id")).toBeNull();
    expect(call[3].headers.Authorization).toBe("Bearer required-api-key");
  });

  it.each(["anonymizeRequests", "customApiSessionPinning"])("uses direct executor and rejects unsupported custom WebSocket transport with %s enabled", async (flag) => {
    const creds = credentials({ anonymizeRequests: false, [flag]: true, executionMode: "claude-code" });
    expect(isClaudeCodeRuntimeEnabled("anthropic-compatible-private", creds)).toBe(false);
    expect(shouldUseClaudeCodeRuntime("anthropic-compatible-private", { credentials: creds, clientMode: "harness" })).toBe(false);
    expect(getExecutor("anthropic-compatible-private", { credentials: creds, clientMode: "harness" })).toBeInstanceOf(DefaultExecutor);
    const form = new FormData();
    form.append("file", new Blob(["audio"]), "audio.wav");
    const result = await handleSttCore({ provider, model: "stt", formData: form, credentials: creds,
      sttConfig: { baseUrl: "https://custom.test", authType: "apiKey", format: "openai" }, transport: "gemini-live" });
    expect(result.status).toBe(400);
    expect(outbound).not.toHaveBeenCalled();
  });
});
