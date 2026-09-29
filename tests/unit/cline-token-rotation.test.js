import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn().mockResolvedValue({}),
}));

const originalFetch = global.fetch;

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
  };
}

function expiredClineConnection(refreshToken) {
  return {
    id: "cline-1",
    provider: "cline",
    authType: "oauth",
    accessToken: "old-access",
    refreshToken,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  };
}

const rotated = (suffix) => ({
  success: true,
  data: {
    accessToken: `access-${suffix}`,
    refreshToken: `refresh-${suffix}`,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  },
});

describe("Cline refresh token rotation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.updateProviderConnection.mockResolvedValue({ id: "cline-1" });
  });
  afterEach(() => { global.fetch = originalFetch; });

  it("keeps the rotated tokens when the connection test probe fails after a refresh", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(expiredClineConnection("rt-probe-fails"));
    global.fetch = vi.fn(async (url) => String(url).includes("/auth/refresh")
      ? jsonResponse(rotated("new"))
      : jsonResponse({ error: "upstream unavailable" }, 503));

    const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js");
    const result = await testSingleConnection("cline-1");

    expect(result.valid).toBe(false);
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("cline-1", expect.objectContaining({
      accessToken: "access-new",
      refreshToken: "refresh-new",
    }));
  });

  it("marks the account for sign-in when the connection test gets invalid_grant", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(expiredClineConnection("rt-rejected"));
    global.fetch = vi.fn(async () => jsonResponse(
      { data: "", error: "failed to refresh token: invalid_grant", success: false }, 400));

    const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js");
    await testSingleConnection("cline-1");

    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("cline-1", expect.objectContaining({
      testStatus: "expired",
      lastErrorType: "token_refresh_failed",
    }));
  });

  it("shares one upstream refresh between the executor and the proactive refresher", async () => {
    let resolveRefresh;
    const fetchMock = vi.fn(() => new Promise((resolve) => { resolveRefresh = resolve; }));
    global.fetch = fetchMock;

    const { getExecutor } = await import("open-sse/executors/index.js");
    const { refreshTokenByProvider } = await import("open-sse/services/tokenRefresh.js");
    const credentials = { refreshToken: "rt-shared" };

    const fromExecutor = getExecutor("cline").refreshCredentials(credentials, null);
    const fromProactive = refreshTokenByProvider("cline", credentials, null);
    await vi.waitFor(() => expect(resolveRefresh).toBeTypeOf("function"));
    resolveRefresh(jsonResponse(rotated("shared")));

    const [a, b] = await Promise.all([fromExecutor, fromProactive]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a.refreshToken).toBe("refresh-shared");
    expect(b.refreshToken).toBe("refresh-shared");
  });

  it("reports a rejected refresh token from the executor so chat stops retrying it", async () => {
    global.fetch = vi.fn(async () => jsonResponse({ error: "invalid_grant" }, 400));
    const { getExecutor } = await import("open-sse/executors/index.js");

    await expect(getExecutor("cline").refreshCredentials({ refreshToken: "rt-dead" }, null))
      .resolves.toEqual({ error: "invalid_grant" });
  });

  it("sends OAuth access tokens with the workos: prefix even when they are not JWTs", async () => {
    const { getExecutor } = await import("open-sse/executors/index.js");
    const headers = getExecutor("cline").buildHeaders({ accessToken: "opaque-token" }, true);

    expect(headers.Authorization).toBe("Bearer workos:opaque-token");
  });

  it("sends ClinePass API keys unchanged", async () => {
    const { getExecutor } = await import("open-sse/executors/index.js");
    const headers = getExecutor("cline").buildHeaders({ apiKey: "clp_key" }, true);

    expect(headers.Authorization).toBe("Bearer clp_key");
  });
});
