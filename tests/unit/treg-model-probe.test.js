import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fx = vi.hoisted(() => ({
  resolveConnectionProxyConfig: vi.fn(),
  proxyAwareFetch: vi.fn(),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: fx.resolveConnectionProxyConfig,
}));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: fx.proxyAwareFetch }));

import { probeConnectionModel, probeModelEndpoint } from "@/lib/modelProbe/probe.js";
import { TREG_CONFIG, TREG_ROUTES } from "open-sse/config/treg.js";

const connection = {
  provider: "treg",
  apiKey: "selected-treg-token",
  providerSpecificData: { org: "test-org" },
};
const IMAGE_MODEL = "replicate.image-gen.flux-schnell";
const platforms = {
  image: "image-gen", video: "video-gen", tts: "voice-gen",
  music: "music-gen", webSearch: "web", webFetch: "web",
};

function authResponse(status = 200) {
  return Response.json({ user: { id: "test-user" } }, { status });
}

function catalogResponse(model = IMAGE_MODEL, overrides = {}) {
  return Response.json({
    endpoint: { id: model, kind: "data", platform: platforms[TREG_ROUTES[model]?.kind], ...overrides },
  });
}

function mockSuccessfulProbe(mock, model = IMAGE_MODEL) {
  mock.mockResolvedValueOnce(authResponse()).mockResolvedValueOnce(catalogResponse(model));
}

function expectReadOnlyProbe(mock, model = IMAGE_MODEL) {
  expect(mock).toHaveBeenCalledTimes(2);
  const [[identityUrl, identity], [catalogUrl, catalog]] = mock.mock.calls;
  expect(identityUrl).toBe(TREG_CONFIG.validateUrl);
  expect(catalogUrl).toBe(`${TREG_CONFIG.baseUrl}/catalog/endpoints/${model}`);
  for (const init of [identity, catalog]) {
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  }
  expect(identity.signal).toBe(catalog.signal);
  expect(new Headers(identity.headers).get("x-treg-token")).toBe(connection.apiKey);
  expect(new Headers(identity.headers).get("x-treg-org")).toBe(connection.providerSpecificData.org);
  expect(new Headers(catalog.headers).get("x-treg-token")).toBeNull();
  expect(new Headers(catalog.headers).get("x-treg-org")).toBeNull();
  expect(new Headers(catalog.headers).get("authorization")).toBeNull();
}

beforeEach(() => {
  vi.clearAllMocks();
  fx.resolveConnectionProxyConfig.mockResolvedValue({});
  fx.proxyAwareFetch.mockReset();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => vi.unstubAllGlobals());

describe("Treg model checks use identity and catalog metadata", () => {
  it.each(Object.entries(TREG_ROUTES))("verifies the configured endpoint %s without generating media", async (model, route) => {
    mockSuccessfulProbe(fetch, model);

    const result = await probeConnectionModel(connection, model, { kind: route.kind });

    expect(result).toEqual({
      ok: true, error: null, status: 200, latencyMs: expect.any(Number),
      note: "Token and catalog endpoint verified; generation was not run",
    });
    expectReadOnlyProbe(fetch, model);
    expect(fx.resolveConnectionProxyConfig).toHaveBeenCalledWith(connection.providerSpecificData);
  });

  it.each(["unknown-model", "__proto__", "constructor", "../../call/treg.web.search"])(
    "rejects unsupported endpoint %s before network calls", async (model) => {
      expect(await probeConnectionModel(connection, model)).toMatchObject({ ok: false, status: 400 });

      expect(fetch).not.toHaveBeenCalled();
      expect(fx.resolveConnectionProxyConfig).not.toHaveBeenCalled();
    },
  );

  it("rejects a requested kind that differs from the configured route", async () => {
    expect(await probeConnectionModel(connection, IMAGE_MODEL, { kind: "video" })).toMatchObject({
      ok: false, status: 400, error: `Treg model '${IMAGE_MODEL}' does not support video`,
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails a missing token before catalog access", async () => {
    expect(await probeConnectionModel({ ...connection, apiKey: "" }, IMAGE_MODEL)).toMatchObject({
      ok: false, error: "Treg token required",
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 503])("stops after unsuccessful identity response %i", async (status) => {
    fetch.mockResolvedValueOnce(authResponse(status));

    const result = await probeConnectionModel(connection, IMAGE_MODEL);

    expect(result).toMatchObject({ ok: false, status });
    expect(result.error).toBe(status === 401 || status === 403
      ? "Invalid Treg API token"
      : `Treg authentication returned HTTP ${status}`);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(TREG_CONFIG.validateUrl);
  });

  it.each([404, 503])("reports catalog failure %i", async (status) => {
    fetch.mockResolvedValueOnce(authResponse()).mockResolvedValueOnce(Response.json({}, { status }));

    expect(await probeConnectionModel(connection, IMAGE_MODEL)).toMatchObject({
      ok: false, status, error: `Treg catalog returned HTTP ${status}`,
    });
    expectReadOnlyProbe(fetch);
  });

  it.each([
    { id: "another-endpoint" },
    { platform: "video-gen" },
    { platform: undefined },
  ])("rejects inconsistent catalog metadata %j", async (overrides) => {
    fetch.mockResolvedValueOnce(authResponse()).mockResolvedValueOnce(catalogResponse(IMAGE_MODEL, overrides));

    expect(await probeConnectionModel(connection, IMAGE_MODEL)).toMatchObject({ ok: false, status: 502 });
    expectReadOnlyProbe(fetch);
  });

  it("rejects invalid metadata JSON", async () => {
    fetch.mockResolvedValueOnce(authResponse()).mockResolvedValueOnce(new Response("broken JSON"));

    expect(await probeConnectionModel(connection, IMAGE_MODEL)).toMatchObject({ ok: false, status: 502 });
    expectReadOnlyProbe(fetch);
  });

  it("returns network errors without falling back to generation or chat", async () => {
    fetch.mockRejectedValueOnce(new Error("Treg unavailable"));

    expect(await probeConnectionModel(connection, IMAGE_MODEL)).toMatchObject({ ok: false, error: "Treg unavailable" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(TREG_CONFIG.validateUrl);
  });

  it("shares a cancellation signal across identity and catalog requests", async () => {
    const caller = new AbortController();
    mockSuccessfulProbe(fetch);

    await probeConnectionModel(connection, IMAGE_MODEL, { signal: caller.signal });

    expectReadOnlyProbe(fetch);
    const signal = fetch.mock.calls[0][1].signal;
    expect(signal.aborted).toBe(false);
    caller.abort();
    expect(signal.aborted).toBe(true);
  });

  it("honors caller cancellation without attempting a catalog request", async () => {
    fetch.mockRejectedValueOnce(new DOMException("Cancelled", "AbortError"));

    expect(await probeConnectionModel(connection, IMAGE_MODEL)).toMatchObject({
      ok: false, error: "Timed out after 20000ms",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { vercelRelayUrl: "https://relay.example" },
    { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.example:3128", connectionNoProxy: "example.com" },
  ])("uses the connection proxy framework for both GETs (%j)", async (proxy) => {
    mockSuccessfulProbe(fx.proxyAwareFetch);

    expect((await probeConnectionModel(connection, IMAGE_MODEL, { proxy })).ok).toBe(true);

    expectReadOnlyProbe(fx.proxyAwareFetch);
    for (const call of fx.proxyAwareFetch.mock.calls) expect(call[2]).toEqual(proxy);
    expect(fx.resolveConnectionProxyConfig).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps explicit endpoint checks on the same nonbillable Treg path", async () => {
    mockSuccessfulProbe(fetch);

    expect((await probeModelEndpoint({
      provider: "treg", model: IMAGE_MODEL, kind: "image",
      apiKey: connection.apiKey, providerSpecificData: connection.providerSpecificData,
      baseUrl: "https://unrelated.example/v1/chat/completions", proxy: {},
    })).ok).toBe(true);

    expectReadOnlyProbe(fetch);
  });
});
