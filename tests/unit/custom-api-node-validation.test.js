import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getNode: vi.fn(), getConnections: vi.fn(), diagnostic: vi.fn(), isLocal: vi.fn(), assertPublic: vi.fn(),
}));
vi.mock("@/models", () => ({
  getProviderNodeById: mocks.getNode,
  getProviderConnections: mocks.getConnections,
}));
vi.mock("@/lib/network/customApi", () => ({ fetchCustomApiDiagnostic: mocks.diagnostic }));
vi.mock("@/dashboardGuard", () => ({ isLocalRequest: mocks.isLocal }));
vi.mock("@/shared/utils/ssrfGuard.js", () => ({ assertPublicUrl: mocks.assertPublic }));
vi.mock("next/server", () => ({ NextResponse: { json: (body, options = {}) => new Response(JSON.stringify(body), options) } }));

import { POST } from "../../src/app/api/provider-nodes/validate/route.js";

const provider = "openai-compatible-node-validation";
const baseUrl = "https://custom.example/v1";
const connection = (id, apiKey, extra = {}) => ({
  id, provider, apiKey,
  providerSpecificData: {
    anonymizeRequests: true,
    customApiSessionPinning: true,
    proxyPoolId: `proxy-${id}`,
    ...extra,
  },
});
const request = (body = {}, signal) => new Request("https://router.example/api/provider-nodes/validate", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ baseUrl, apiKey: "key-a", type: "openai-compatible", ...body }),
  signal,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn());
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.getNode.mockResolvedValue({ id: provider });
  mocks.getConnections.mockResolvedValue([connection("a", "key-a"), connection("b", "key-b")]);
  mocks.diagnostic.mockResolvedValue(new Response(JSON.stringify({ data: [] })));
  mocks.isLocal.mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("existing custom node validation", () => {
  it("uses the matching saved key's privacy and pinned proxy configuration", async () => {
    const result = await POST(request({ provider }));
    expect(await result.json()).toEqual({ valid: true });
    expect(mocks.getConnections).toHaveBeenCalledWith({ provider });
    expect(mocks.diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a", providerSpecificData: expect.objectContaining({ anonymizeRequests: true, customApiSessionPinning: true, proxyPoolId: "proxy-a" }) }),
      `${baseUrl}/models`,
      expect.objectContaining({ headers: { Authorization: "Bearer key-a" }, signal: expect.any(AbortSignal) }),
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("uses a different saved account's own proxy configuration for its key", async () => {
    const result = await POST(request({ provider, apiKey: "key-b" }));
    expect((await result.json()).valid).toBe(true);
    expect(mocks.diagnostic.mock.calls[0][0]).toMatchObject({ id: "b", apiKey: "key-b", providerSpecificData: { proxyPoolId: "proxy-b" } });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("keeps the account's settings when validating a draft replacement URL", async () => {
    const result = await POST(request({ provider, baseUrl: "https://replacement.example/v1" }));
    expect((await result.json()).valid).toBe(true);
    expect(mocks.diagnostic.mock.calls[0][0].id).toBe("a");
    expect(mocks.diagnostic.mock.calls[0][1]).toBe("https://replacement.example/v1/models");
  });

  it("routes every fallback attempt through the matching account transport", async () => {
    mocks.diagnostic.mockResolvedValueOnce(new Response(null, { status: 404 })).mockResolvedValueOnce(new Response("{}"));
    expect((await (await POST(request({ provider, modelId: "model-a" }))).json()).valid).toBe(true);
    expect(mocks.diagnostic.mock.calls.map((call) => call[0].id)).toEqual(["a", "a"]);
    expect(mocks.diagnostic.mock.calls.map((call) => call[1])).toEqual([`${baseUrl}/models`, `${baseUrl}/chat/completions`]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("uses saved custom embedding settings for embedding checks", async () => {
    const embeddingProvider = "custom-embedding-node-validation";
    mocks.getNode.mockResolvedValue({ id: embeddingProvider });
    mocks.getConnections.mockResolvedValue([{ ...connection("embedding", "key-a"), provider: embeddingProvider }]);
    mocks.diagnostic.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] })));
    const result = await POST(request({ provider: embeddingProvider, type: "custom-embedding", modelId: "embed-a" }));
    expect(await result.json()).toEqual({ valid: true, method: "embeddings", dimensions: 3 });
    expect(mocks.diagnostic.mock.calls[0][1]).toBe(`${baseUrl}/embeddings`);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("fails closed when the saved account's proxy transport fails", async () => {
    mocks.diagnostic.mockRejectedValueOnce(new Error("Pinned proxy unavailable"));
    const result = await POST(request({ provider }));
    expect(result.status).toBe(500);
    expect((await result.json()).valid).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("checks remote destination URL policy before looking up a saved account", async () => {
    mocks.isLocal.mockReturnValue(false);
    mocks.assertPublic.mockImplementationOnce(() => { throw new Error("Private address"); });
    const result = await POST(request({ provider, baseUrl: "http://127.0.0.1/v1" }));
    expect(result.status).toBe(400);
    expect(await result.json()).toEqual({ error: "URL not allowed" });
    expect(mocks.getConnections).not.toHaveBeenCalled();
    expect(mocks.diagnostic).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("new node validation and cancellation", () => {
  it("keeps ordinary fetch behavior for a new node without a saved provider ID", async () => {
    globalThis.fetch.mockResolvedValueOnce(new Response("{}"));
    expect((await (await POST(request())).json()).valid).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(`${baseUrl}/models`, expect.objectContaining({ headers: { Authorization: "Bearer key-a" }, signal: expect.any(AbortSignal) }));
    expect(mocks.getNode).not.toHaveBeenCalled();
    expect(mocks.diagnostic).not.toHaveBeenCalled();
  });

  it("keeps ordinary fetch behavior for a key that is not saved on the node", async () => {
    globalThis.fetch.mockResolvedValueOnce(new Response("{}"));
    expect((await (await POST(request({ provider, apiKey: "unsaved-key" }))).json()).valid).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.diagnostic).not.toHaveBeenCalled();
  });

  it("does not borrow privacy settings from another provider with the same key", async () => {
    mocks.getConnections.mockResolvedValue([{ ...connection("other", "key-a"), provider: "openai-compatible-other" }]);
    globalThis.fetch.mockResolvedValueOnce(new Response("{}"));
    expect((await (await POST(request({ provider }))).json()).valid).toBe(true);
    expect(mocks.diagnostic).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("aborts the actual upstream fetch when the incoming request is canceled", async () => {
    const abort = new AbortController();
    let reportSignal;
    const gotSignal = new Promise((resolve) => { reportSignal = resolve; });
    globalThis.fetch.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      reportSignal(options.signal);
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }));
    const result = POST(request({}, abort.signal));
    const upstreamSignal = await gotSignal;
    expect(upstreamSignal.aborted).toBe(false);
    abort.abort(new Error("Client canceled"));
    expect(upstreamSignal.aborted).toBe(true);
    expect((await result).status).toBe(500);
  });

  it("aborts the actual upstream fetch at the validation deadline", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let reportSignal;
    const gotSignal = new Promise((resolve) => { reportSignal = resolve; });
    globalThis.fetch.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      reportSignal(options.signal);
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }));
    const result = POST(request());
    const upstreamSignal = await gotSignal;
    expect(timeout).toHaveBeenCalledWith(10000);
    deadline.abort(new DOMException("Request timeout", "TimeoutError"));
    expect(upstreamSignal.aborted).toBe(true);
    expect((await (await result).json()).error).toContain("timeout");
  });

  it("logs only the error category, never thrown credential details", async () => {
    mocks.diagnostic.mockRejectedValueOnce(new Error("request failed with key-a and proxy-password"));
    await POST(request({ provider }));
    expect(JSON.stringify(console.error.mock.calls)).not.toContain("key-a");
    expect(JSON.stringify(console.error.mock.calls)).not.toContain("proxy-password");
  });
});
