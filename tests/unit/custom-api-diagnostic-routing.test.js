import { beforeEach, describe, expect, it, vi } from "vitest";

const { getConnection, updateConnection, diagnostic, resolveProxy, testProxy } = vi.hoisted(() => ({
  getConnection: vi.fn(), updateConnection: vi.fn(), diagnostic: vi.fn(), resolveProxy: vi.fn(), testProxy: vi.fn(),
}));
vi.mock("@/models", () => ({ getProviderConnectionById: getConnection }));
vi.mock("@/lib/localDb", () => ({ getProviderConnectionById: getConnection, updateProviderConnection: updateConnection }));
vi.mock("@/lib/network/customApi", () => ({ fetchCustomApiDiagnostic: (...args) => diagnostic(...args) }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: resolveProxy }));
vi.mock("@/lib/network/proxyTest", () => ({ testProxyUrl: testProxy }));
vi.mock("@/sse/services/tokenRefresh", () => ({ refreshGoogleToken: vi.fn(), refreshCodexToken: vi.fn(), updateProviderCredentials: vi.fn() }));
vi.mock("next/server", () => ({ NextResponse: { json: (body, options = {}) => new Response(JSON.stringify(body), options) } }));

import { GET } from "../../src/app/api/providers/[id]/models/route.js";
import { testSingleConnection } from "../../src/app/api/providers/[id]/test/testUtils.js";

const proxy = { connectionProxyEnabled: true, connectionProxyUrl: "http://customer-session-{session}:password@proxy.test:22225" };
const makeConnection = (provider, data = {}) => ({
  id: "connection-a", provider, apiKey: "key", authType: "apikey",
  providerSpecificData: { baseUrl: "https://custom.test/v1", anonymizeRequests: true, customApiSessionPinning: true, ...data },
});
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  vi.clearAllMocks();
  resolveProxy.mockResolvedValue(proxy);
  testProxy.mockResolvedValue({ ok: true });
  updateConnection.mockResolvedValue({});
});

describe("custom API model discovery", () => {
  it.each(["openai-compatible-test", "anthropic-compatible-test", "custom-embedding-test"])("routes %s through the diagnostic privacy/pinning transport", async (provider) => {
    const connection = makeConnection(provider);
    getConnection.mockResolvedValue(connection);
    diagnostic.mockResolvedValue(response({ data: [{ id: "model-a" }] }));
    const request = new Request("https://router.test/api/providers/connection-a/models");
    const result = await GET(request, { params: Promise.resolve({ id: connection.id }) });
    expect((await result.json()).models).toEqual([{ id: "model-a" }]);
    expect(diagnostic).toHaveBeenCalledWith(connection, "https://custom.test/v1/models", expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) }));
  });

  it("routes both the typed endpoint and its catalog fallback through the diagnostic transport", async () => {
    const connection = makeConnection("openai-compatible-test", { mediaKinds: ["image"] });
    getConnection.mockResolvedValue(connection);
    diagnostic.mockResolvedValueOnce(response({ error: "unsupported" }, 404)).mockResolvedValueOnce(response({ data: [{ id: "image-a" }] }));
    const result = await GET(new Request("https://router.test/api/providers/connection-a/models?kind=image"), { params: Promise.resolve({ id: connection.id }) });
    expect((await result.json()).models).toEqual([{ id: "image-a" }]);
    expect(diagnostic.mock.calls.map((call) => call[1])).toEqual(["https://custom.test/v1/models/image", "https://custom.test/v1/models"]);
  });
});

describe("custom API connection tests", () => {
  it.each(["openai-compatible-test", "anthropic-compatible-test", "custom-embedding-test"])("routes %s diagnostics through pinning without probing raw session placeholders", async (provider) => {
    const connection = makeConnection(provider);
    getConnection.mockResolvedValue(connection);
    diagnostic.mockResolvedValue(response({ data: [] }));
    const result = await testSingleConnection(connection.id);
    expect(result.valid).toBe(true);
    expect(testProxy).not.toHaveBeenCalled();
    expect(diagnostic).toHaveBeenCalledWith(connection, expect.any(String), expect.objectContaining({ signal: expect.any(AbortSignal) }), proxy);
  });

  it("retains the preliminary proxy connectivity test when session pinning is disabled", async () => {
    const connection = makeConnection("openai-compatible-test", { customApiSessionPinning: false });
    getConnection.mockResolvedValue(connection);
    diagnostic.mockResolvedValue(response({ data: [] }));
    expect((await testSingleConnection(connection.id)).valid).toBe(true);
    expect(testProxy).toHaveBeenCalledWith({ proxyUrl: proxy.connectionProxyUrl });
  });
});
