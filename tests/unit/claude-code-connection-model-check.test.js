import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fx = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  testProxyUrl: vi.fn(),
  probeConnectionModel: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: fx.getProviderConnectionById,
  updateProviderConnection: fx.updateProviderConnection,
}));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: fx.resolveConnectionProxyConfig }));
vi.mock("@/lib/network/proxyTest", () => ({ testProxyUrl: fx.testProxyUrl }));
vi.mock("@/lib/modelProbe/probe", () => ({ probeConnectionModel: fx.probeConnectionModel }));
vi.mock("next/server", () => ({ NextResponse: { json: (body, init = {}) => Response.json(body, init) } }));

const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js");
const { POST } = await import("../../src/app/api/providers/[id]/test/route.js");
const connection = (overrides = {}) => ({
  id: "saved-key",
  provider: "anthropic-compatible-custom",
  authType: "apikey",
  apiKey: "chosen-upstream-key",
  defaultModel: "claude-model",
  providerSpecificData: { baseUrl: "https://upstream.example", executionMode: "claude-code" },
  ...overrides,
});

describe("saved compatible connection tests use the configured model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fx.getProviderConnectionById.mockResolvedValue(connection());
    fx.updateProviderConnection.mockResolvedValue({});
    fx.resolveConnectionProxyConfig.mockResolvedValue({});
    fx.testProxyUrl.mockResolvedValue({ ok: true });
    fx.probeConnectionModel.mockResolvedValue({ ok: true, error: null, latencyMs: 12, status: 200 });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => { throw new Error("Unexpected auth-only request"); }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("probes the exact saved Claude Code key and marks a successful model active", async () => {
    const signal = new AbortController().signal;
    const result = await testSingleConnection("saved-key", { signal });

    expect(result).toEqual({ valid: true, error: null, refreshed: false, latencyMs: expect.any(Number), testedAt: expect.any(String) });
    expect(fx.probeConnectionModel).toHaveBeenCalledWith(connection(), "claude-model", { proxy: {}, signal });
    expect(fx.updateProviderConnection).toHaveBeenCalledWith("saved-key", {
      testStatus: "active", lastError: null, lastErrorAt: null,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("honors a direct key's mode while checking its configured model", async () => {
    const saved = connection({ providerSpecificData: { baseUrl: "https://upstream.example", executionMode: "direct" } });
    fx.getProviderConnectionById.mockResolvedValue(saved);

    expect((await testSingleConnection("saved-key")).valid).toBe(true);
    expect(fx.probeConnectionModel).toHaveBeenCalledWith(saved, "claude-model", { proxy: {}, signal: undefined });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([400, 403, 404, 529])("marks configured-model rejection %i as error rather than accepted authentication", async (status) => {
    const error = `HTTP ${status}: model unavailable for this key`;
    fx.probeConnectionModel.mockResolvedValue({ ok: false, error, status, latencyMs: 8 });

    expect(await testSingleConnection("saved-key")).toEqual({
      valid: false, error, refreshed: false, latencyMs: expect.any(Number), testedAt: expect.any(String),
    });
    expect(fx.updateProviderConnection).toHaveBeenCalledWith("saved-key", {
      testStatus: "error", lastError: error, lastErrorAt: expect.any(String),
    });
    expect(fx.probeConnectionModel).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("tests a saved OpenAI compatible connection's model through its own key", async () => {
    const saved = connection({ provider: "openai-compatible-custom", defaultModel: "my-model" });
    fx.getProviderConnectionById.mockResolvedValue(saved);

    expect((await testSingleConnection("saved-key")).valid).toBe(true);
    expect(fx.probeConnectionModel).toHaveBeenCalledWith(saved, "my-model", { proxy: {}, signal: undefined });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reuses the resolved relay settings for the model probe", async () => {
    const proxy = { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.example:3128", vercelRelayUrl: "https://relay.example" };
    fx.resolveConnectionProxyConfig.mockResolvedValue(proxy);

    await testSingleConnection("saved-key");

    expect(fx.probeConnectionModel).toHaveBeenCalledWith(connection(), "claude-model", { proxy, signal: undefined });
    expect(fx.resolveConnectionProxyConfig).toHaveBeenCalledTimes(1);
    expect(fx.testProxyUrl).not.toHaveBeenCalled();
  });

  it("keeps the existing proxy failure verdict without launching a model probe", async () => {
    fx.resolveConnectionProxyConfig.mockResolvedValue({ connectionProxyEnabled: true, connectionProxyUrl: "http://bad-proxy.example:3128" });
    fx.testProxyUrl.mockResolvedValue({ ok: false, error: "Proxy unreachable" });

    expect((await testSingleConnection("saved-key")).valid).toBe(false);
    expect(fx.updateProviderConnection).toHaveBeenCalledWith("saved-key", expect.objectContaining({
      testStatus: "error", lastError: "Proxy unreachable",
    }));
    expect(fx.probeConnectionModel).not.toHaveBeenCalled();
  });

  it("keeps the cheap OpenAI key check when no default model is configured", async () => {
    fx.getProviderConnectionById.mockResolvedValue(connection({ provider: "openai-compatible-custom", defaultModel: null }));
    fetch.mockResolvedValue(new Response("{}", { status: 200 }));

    expect((await testSingleConnection("saved-key")).valid).toBe(true);
    expect(fetch).toHaveBeenCalledWith("https://upstream.example/models", expect.objectContaining({
      headers: { Authorization: "Bearer chosen-upstream-key" },
    }));
    expect(fx.probeConnectionModel).not.toHaveBeenCalled();
  });

  it("keeps the existing Anthropic key check when no default model is configured", async () => {
    fx.getProviderConnectionById.mockResolvedValue(connection({ defaultModel: null }));
    fetch.mockResolvedValue(new Response("{}", { status: 400 }));

    expect((await testSingleConnection("saved-key")).valid).toBe(true);
    expect(fetch).toHaveBeenCalledWith("https://upstream.example/v1/messages", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ model: "claude-3-haiku-20240307", max_tokens: 1, messages: [{ role: "user", content: "test" }] }),
    }));
    expect(fx.probeConnectionModel).not.toHaveBeenCalled();
  });

  it("keeps OAuth connection validation even when its default model is configured", async () => {
    fx.getProviderConnectionById.mockResolvedValue(connection({ provider: "cursor", authType: "oauth", accessToken: "cursor-token" }));

    expect((await testSingleConnection("saved-key")).valid).toBe(true);
    expect(fx.probeConnectionModel).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards cancellation from the saved-connection test route", async () => {
    const request = new Request("http://localhost/api/providers/saved-key/test", { method: "POST" });
    const res = await POST(request, { params: Promise.resolve({ id: "saved-key" }) });

    expect(await res.json()).toEqual({ valid: true, error: null, refreshed: false });
    expect(fx.probeConnectionModel).toHaveBeenCalledWith(connection(), "claude-model", { proxy: {}, signal: request.signal });
  });

  it("still returns 404 for a missing saved connection", async () => {
    fx.getProviderConnectionById.mockResolvedValue(null);
    const res = await POST(new Request("http://localhost/api/providers/missing/test", { method: "POST" }), { params: Promise.resolve({ id: "missing" }) });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Connection not found" });
    expect(fx.probeConnectionModel).not.toHaveBeenCalled();
    expect(fx.updateProviderConnection).not.toHaveBeenCalled();
  });
});
