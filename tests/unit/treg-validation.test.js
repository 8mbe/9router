import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fx = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  testProxyUrl: vi.fn(),
  proxyAwareFetch: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: fx.getProviderConnectionById,
  updateProviderConnection: fx.updateProviderConnection,
}));
vi.mock("@/models", () => ({ getProviderNodeById: vi.fn() }));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: fx.resolveConnectionProxyConfig,
}));
vi.mock("@/lib/network/proxyTest", () => ({ testProxyUrl: fx.testProxyUrl }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: fx.proxyAwareFetch }));
vi.mock("next/server", () => ({
  NextResponse: { json: (body, init = {}) => Response.json(body, init) },
}));

import { POST as validateToken } from "@/app/api/providers/validate/route.js";
import { testSingleConnection } from "@/app/api/providers/[id]/test/testUtils.js";
import { TREG_CONFIG } from "open-sse/config/treg.js";

const savedConnection = {
  id: "treg-key",
  provider: "treg",
  authType: "apikey",
  apiKey: "treg-test-token",
  providerSpecificData: {},
};

function validationRequest(overrides = {}) {
  return new Request("https://9router.local/api/providers/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "treg",
      apiKey: savedConnection.apiKey,
      providerSpecificData: savedConnection.providerSpecificData,
      ...overrides,
    }),
  });
}

function upstreamResponse(status = 200) {
  return Response.json({ user: { id: "test-user" } }, { status });
}

function expectIdentityGet(mock) {
  expect(mock).toHaveBeenCalledTimes(1);
  const [url, init] = mock.mock.calls[0];
  expect(url).toBe(TREG_CONFIG.validateUrl);
  expect(url).toBe("https://treg.to/auth/me");
  expect(init.method).toBe("GET");
  expect(init.body).toBeUndefined();
  expect(new Headers(init.headers).get("x-treg-token")).toBe(savedConnection.apiKey);
  expect(new Headers(init.headers).get("authorization")).toBeNull();
  expect(init.signal).toBeInstanceOf(AbortSignal);
}

beforeEach(() => {
  vi.clearAllMocks();
  fx.getProviderConnectionById.mockResolvedValue(savedConnection);
  fx.updateProviderConnection.mockResolvedValue({});
  fx.resolveConnectionProxyConfig.mockResolvedValue({});
  fx.testProxyUrl.mockResolvedValue({ ok: true });
  fx.proxyAwareFetch.mockResolvedValue(upstreamResponse());
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(upstreamResponse()));
});

afterEach(() => vi.unstubAllGlobals());

describe("Treg API token validation", () => {
  it("checks identity with GET instead of generating paid output", async () => {
    const response = await validateToken(validationRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ valid: true, error: null });
    expectIdentityGet(fetch);
  });

  it.each([401, 403, 429, 503])("rejects an unsuccessful identity response %i", async (status) => {
    fetch.mockResolvedValueOnce(upstreamResponse(status));

    const response = await validateToken(validationRequest());
    const body = await response.json();

    expect(body.valid).toBe(false);
    expect(body.error).toBe(status === 401 || status === 403
      ? "Invalid Treg API token"
      : `Treg authentication returned HTTP ${status}`);
    expectIdentityGet(fetch);
  });

  it("returns a network failure without submitting another request", async () => {
    fetch.mockRejectedValueOnce(new Error("Identity endpoint unavailable"));

    const response = await validateToken(validationRequest());

    expect(await response.json()).toEqual({ valid: false, error: "Identity endpoint unavailable" });
    expectIdentityGet(fetch);
  });

  it("requires an API token before calling Treg", async () => {
    const response = await validateToken(validationRequest({ apiKey: "" }));

    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends optional organization scope with the identity token", async () => {
    await validateToken(validationRequest({ providerSpecificData: { org: "test-org" } }));

    expect(new Headers(fetch.mock.calls[0][1].headers).get("x-treg-org")).toBe("test-org");
    expectIdentityGet(fetch);
  });
});

describe("saved Treg connection test", () => {
  it("marks a successful identity check active", async () => {
    const result = await testSingleConnection(savedConnection.id);

    expect(result).toMatchObject({ valid: true, error: null, refreshed: false });
    expectIdentityGet(fetch);
    expect(fx.updateProviderConnection).toHaveBeenCalledWith(savedConnection.id, {
      testStatus: "active", lastError: null, lastErrorAt: null,
    });
  });

  it.each([401, 403, 429, 503])("marks identity failure %i as an error", async (status) => {
    fetch.mockResolvedValueOnce(upstreamResponse(status));

    const result = await testSingleConnection(savedConnection.id);

    expect(result.valid).toBe(false);
    expect(fx.updateProviderConnection).toHaveBeenCalledWith(savedConnection.id, {
      testStatus: "error", lastError: result.error, lastErrorAt: expect.any(String),
    });
    expectIdentityGet(fetch);
  });

  it("uses the configured relay for the same nonbillable identity GET", async () => {
    const proxy = { vercelRelayUrl: "https://relay.example" };
    fx.resolveConnectionProxyConfig.mockResolvedValueOnce(proxy);

    expect((await testSingleConnection(savedConnection.id)).valid).toBe(true);

    expectIdentityGet(fx.proxyAwareFetch);
    expect(fx.proxyAwareFetch.mock.calls[0][2]).toEqual(proxy);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses a connection proxy after its connectivity test succeeds", async () => {
    const proxy = {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.example:3128",
      connectionNoProxy: "example.com",
    };
    fx.resolveConnectionProxyConfig.mockResolvedValueOnce(proxy);

    expect((await testSingleConnection(savedConnection.id)).valid).toBe(true);

    expect(fx.testProxyUrl).toHaveBeenCalledWith({ proxyUrl: proxy.connectionProxyUrl });
    expectIdentityGet(fx.proxyAwareFetch);
    expect(fx.proxyAwareFetch.mock.calls[0][2]).toEqual(proxy);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends stored organization scope with the identity token", async () => {
    const connection = {
      ...savedConnection,
      providerSpecificData: { org: "test-org" },
    };
    fx.getProviderConnectionById.mockResolvedValueOnce(connection);

    await testSingleConnection(savedConnection.id);

    expect(new Headers(fetch.mock.calls[0][1].headers).get("x-treg-org")).toBe("test-org");
    expectIdentityGet(fetch);
  });

  it("records a failed identity request without generating paid output", async () => {
    fetch.mockRejectedValueOnce(new Error("Network unavailable"));

    const result = await testSingleConnection(savedConnection.id);

    expect(result).toMatchObject({ valid: false, error: "Network unavailable" });
    expectIdentityGet(fetch);
    expect(fx.updateProviderConnection).toHaveBeenCalledWith(savedConnection.id, {
      testStatus: "error", lastError: "Network unavailable", lastErrorAt: expect.any(String),
    });
  });
});
