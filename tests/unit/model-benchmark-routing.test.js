import { beforeEach, describe, expect, it, vi } from "vitest";

const fx = vi.hoisted(() => ({
  getModelInfo: vi.fn(),
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  getProviderCredentials: vi.fn(),
  checkAndRefreshToken: vi.fn(),
  updateProviderCredentials: vi.fn(),
  getProjectIdForConnection: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  probeConnectionModel: vi.fn(),
  handleChatCore: vi.fn(),
  consumeProbeStream: vi.fn(),
  pingModelByKind: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: (body, init) => Response.json(body, init) } }));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: fx.handleChatCore }));
vi.mock("open-sse/services/projectId.js", () => ({ getProjectIdForConnection: fx.getProjectIdForConnection }));
vi.mock("@/lib/localDb", () => ({ getProviderConnections: fx.getProviderConnections, getSettings: fx.getSettings }));
vi.mock("@/sse/services/model", () => ({ getModelInfo: fx.getModelInfo }));
vi.mock("@/sse/services/auth", () => ({ getProviderCredentials: fx.getProviderCredentials }));
vi.mock("@/sse/services/tokenRefresh", () => ({
  checkAndRefreshToken: fx.checkAndRefreshToken,
  updateProviderCredentials: fx.updateProviderCredentials,
}));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: fx.resolveConnectionProxyConfig }));
vi.mock("@/lib/modelProbe/probe", () => ({ probeConnectionModel: fx.probeConnectionModel }));
vi.mock("@/lib/modelProbe/streamMetrics", async (importOriginal) => ({
  ...await importOriginal(), consumeProbeStream: fx.consumeProbeStream,
}));
vi.mock("@/app/api/models/test/ping", () => ({ pingModelByKind: fx.pingModelByKind }));

import { POST } from "@/app/api/models/test/route";

const connection = (id, extra = {}) => ({
  id,
  provider: "openai-compatible-test",
  name: `Key ${id}`,
  apiKey: `secret-${id}`,
  isActive: true,
  providerSpecificData: { baseUrl: "https://upstream.example/v1" },
  ...extra,
});
const success = (scale = 1) => ({
  ok: true, error: null, latencyMs: 1100 * scale, ttftMs: 100 * scale,
  responseDurationMs: 1000 * scale, tokensPerSecond: 20 * scale, outputTokens: 20 * scale,
});
const request = (extra = {}, signal) => new Request("http://localhost/api/models/test", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model: "custom/essay-model", testType: "essay", ...extra }),
  signal,
});

beforeEach(() => {
  vi.clearAllMocks();
  fx.getModelInfo.mockResolvedValue({ provider: "openai-compatible-test", model: "essay-model" });
  fx.getProviderConnections.mockResolvedValue([connection("one")]);
  fx.getSettings.mockResolvedValue({});
  fx.probeConnectionModel.mockResolvedValue(success());
  fx.resolveConnectionProxyConfig.mockResolvedValue({ connectionProxyEnabled: false });
  fx.checkAndRefreshToken.mockImplementation(async (_, credentials) => credentials);
  fx.handleChatCore.mockImplementation(async () => ({ success: true, response: new Response("stream") }));
  fx.consumeProbeStream.mockResolvedValue(success());
  fx.updateProviderCredentials.mockResolvedValue(null);
});

describe("model Ping and Essay routing", () => {
  it("tests every active key and averages successful measurements without hiding key errors", async () => {
    fx.getProviderConnections.mockResolvedValue([
      connection("one"), connection("two"), connection("three"), connection("disabled", { isActive: false }),
    ]);
    fx.probeConnectionModel.mockResolvedValueOnce(success())
      .mockResolvedValueOnce({ ok: false, latencyMs: 50000, error: "HTTP 403: model denied" })
      .mockResolvedValueOnce(success(3));

    const body = await (await POST(request())).json();

    expect(fx.getProviderConnections).toHaveBeenCalledWith({ provider: "openai-compatible-test", isActive: true });
    expect(fx.probeConnectionModel.mock.calls.map(([key]) => key.id)).toEqual(["one", "two", "three"]);
    expect(body).toMatchObject({
      testType: "essay", ok: false, totalCount: 3, successCount: 2,
      latencyMs: 2200, ttftMs: 200, responseDurationMs: 2000, tokensPerSecond: 40,
      errors: [{ connectionId: "two", connectionName: "Key two", error: "HTTP 403: model denied" }],
    });
    expect(JSON.stringify(body)).not.toContain("secret-");
    expect(fx.pingModelByKind).not.toHaveBeenCalled();
  });

  it.each(["ping", "essay"])("passes %s through the exact Anthropic key's configured execution mode", async (testType) => {
    const key = connection("claude", { provider: "anthropic-compatible-test", providerSpecificData: { executionMode: "claude-code" } });
    fx.getModelInfo.mockResolvedValue({ provider: key.provider, model: "claude-model" });
    fx.getProviderConnections.mockResolvedValue([key]);
    const req = request({ testType });

    expect(await (await POST(req)).json()).toMatchObject({ ok: true, totalCount: 1, testType });
    expect(fx.probeConnectionModel).toHaveBeenCalledWith(key, "claude-model", { testType, signal: expect.any(AbortSignal) });
    expect(fx.handleChatCore).not.toHaveBeenCalled();
  });

  it("continues to the next key when one probe throws", async () => {
    fx.getProviderConnections.mockResolvedValue([connection("one"), connection("two")]);
    fx.probeConnectionModel.mockRejectedValueOnce(new Error("Connection refused"));

    expect(await (await POST(request())).json()).toMatchObject({
      totalCount: 2, successCount: 1, ttftMs: 100,
      errors: [{ connectionId: "one", error: "Connection refused" }],
    });
  });

  it("runs built-in providers with pinned OAuth credentials and the exact essay prompt", async () => {
    fx.getModelInfo.mockResolvedValue({ provider: "codex", model: "gpt-5" });
    fx.getProviderConnections.mockResolvedValue([
      connection("one", { provider: "codex", accessToken: "oauth-one" }),
      connection("two", { provider: "codex", accessToken: "oauth-two" }),
    ]);
    fx.getSettings.mockResolvedValue({ providerThinking: { codex: { mode: "low" } }, providerOverrides: { codex: { timeout: 30000 } } });
    fx.resolveConnectionProxyConfig.mockResolvedValue({ connectionProxyEnabled: true, connectionProxyUrl: "http://proxy", proxyPoolId: "pool", strictProxy: true });

    expect(await (await POST(request())).json()).toMatchObject({ successCount: 2, totalCount: 2 });
    expect(fx.handleChatCore.mock.calls.map(([args]) => args.credentials.accessToken)).toEqual(["oauth-one", "oauth-two"]);
    expect(fx.handleChatCore).toHaveBeenCalledWith(expect.objectContaining({
      body: {
        model: "codex/gpt-5", messages: [{ role: "user", content: "write a small essay" }],
        max_tokens: 2048, stream: true, stream_options: { include_usage: true },
      },
      credentials: expect.objectContaining({
        connectionId: "one",
        providerSpecificData: expect.objectContaining({ connectionProxyPoolId: "pool", strictProxy: true }),
      }),
      providerThinking: { mode: "low" }, providerOverrides: { timeout: 30000 }, signal: expect.any(AbortSignal),
    }));
    expect(fx.checkAndRefreshToken).toHaveBeenCalledTimes(2);
    expect(fx.getProviderCredentials).not.toHaveBeenCalled();
    expect(fx.pingModelByKind).not.toHaveBeenCalled();
  });

  it("keeps Ping short while leaving reasoning models enough output budget", async () => {
    fx.getModelInfo.mockResolvedValue({ provider: "openai", model: "test-model" });
    await POST(request({ testType: "ping" }));

    expect(fx.handleChatCore).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ messages: [{ role: "user", content: "Ping. Reply with pong." }], max_tokens: 1024 }),
    }));
  });

  it("resolves missing Google project IDs for the connection being tested", async () => {
    fx.getModelInfo.mockResolvedValue({ provider: "antigravity", model: "gemini-model" });
    fx.getProviderConnections.mockResolvedValue([connection("google", { provider: "antigravity", accessToken: "google-token" })]);
    fx.getProjectIdForConnection.mockResolvedValue("project-123");

    await POST(request());

    expect(fx.getProjectIdForConnection).toHaveBeenCalledWith("google", "google-token", "antigravity");
    expect(fx.handleChatCore).toHaveBeenCalledWith(expect.objectContaining({ credentials: expect.objectContaining({ projectId: "project-123" }) }));
  });

  it("passes canceled requests to the result without starting an upstream request", async () => {
    const controller = new AbortController();
    controller.abort();

    const body = await (await POST(request({}, controller.signal))).json();
    expect(body).toMatchObject({ ok: false, errors: [{ error: "Test canceled" }] });
    expect(fx.probeConnectionModel).not.toHaveBeenCalled();
    expect(fx.handleChatCore).not.toHaveBeenCalled();
  });

  it("reports the configured deadline and keeps partial metrics when the probe times out", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    fx.probeConnectionModel.mockImplementationOnce(async () => {
      deadline.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
      return { ...success(), ok: false, error: "Model test cancelled" };
    });
    try {
      expect(await (await POST(request({ testType: "ping" }))).json()).toMatchObject({
        ok: false, error: "Timed out after 15000ms", ttftMs: 100, responseDurationMs: 1000,
      });
    } finally {
      timeout.mockRestore();
    }
  });

  it("reports missing credentials without using another provider or key", async () => {
    fx.getProviderConnections.mockResolvedValue([]);
    expect(await (await POST(request())).json()).toMatchObject({ ok: false, error: "No active credentials for provider: openai-compatible-test" });
    expect(fx.handleChatCore).not.toHaveBeenCalled();
    expect(fx.pingModelByKind).not.toHaveBeenCalled();
  });

  it.each([{ testType: "unknown" }, { kind: "image" }, { kind: "embedding" }])("rejects invalid benchmark request %j before upstream work", async (extra) => {
    expect((await POST(request(extra))).status).toBe(400);
    expect(fx.getModelInfo).not.toHaveBeenCalled();
    expect(fx.probeConnectionModel).not.toHaveBeenCalled();
  });
});
