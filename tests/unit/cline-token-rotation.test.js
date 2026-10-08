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

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => globalThis.fetch(...args),
}));

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function rotatedTokens(account) {
  return {
    success: true,
    data: {
      accessToken: `access-${account}`,
      refreshToken: `refresh-${account}`,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
  };
}

describe("Cline refresh token rotation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.updateProviderConnection.mockResolvedValue({ id: "cline-1" });
    // Every network call must be explicitly handled by the individual test.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network call"); }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shares one upstream refresh between the chat executor and the proactive refresher", async () => {
    const replies = [];
    fetch.mockImplementation(() => new Promise((resolve) => { replies.push(resolve); }));
    const { DefaultExecutor } = await import("open-sse/executors/default.js");
    const { refreshTokenByProvider } = await import("open-sse/services/tokenRefresh.js");
    const credentials = { refreshToken: "refresh-before-rotation" };

    const fromExecutor = new DefaultExecutor("cline").refreshCredentials(credentials, null);
    const fromProactive = refreshTokenByProvider("cline", credentials, null);
    // Start both paths before allowing either upstream response to finish.
    await Promise.resolve();
    for (const reply of replies) reply(response(rotatedTokens("shared")));
    const [executorResult, proactiveResult] = await Promise.all([fromExecutor, fromProactive]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(executorResult.refreshToken).toBe("refresh-shared");
    expect(proactiveResult.refreshToken).toBe("refresh-shared");
    expect(executorResult.lastRefreshAt).toBeTruthy();
    expect(executorResult.lastRefreshAt).toBe(proactiveResult.lastRefreshAt);
  });

  it.each([401, 403, 503])("persists rotated tokens when the following connection probe returns %i", async (probeStatus) => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "cline-1",
      provider: "cline",
      authType: "oauth",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    let refreshCalls = 0;
    fetch.mockImplementation(async (url) => {
      if (String(url).endsWith("/auth/refresh")) {
        refreshCalls += 1;
        return refreshCalls === 1
          ? response(rotatedTokens("new"))
          : response({ error: "invalid_grant" }, 400);
      }
      if (String(url).endsWith("/users/me")) {
        return response({ error: "probe rejected" }, probeStatus);
      }
      throw new Error(`Unexpected mocked endpoint: ${url}`);
    });
    const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js");

    const result = await testSingleConnection("cline-1");

    expect(result.valid).toBe(false);
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("cline-1", expect.objectContaining({
      accessToken: "access-new",
      refreshToken: "refresh-new",
      lastRefreshAt: expect.any(String),
    }));
    expect(refreshCalls).toBe(1);
  });

  it("persists rotated tokens when the following connection probe throws", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "cline-1", provider: "cline", authType: "oauth",
      accessToken: "old-access", refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    fetch.mockImplementation(async (url) => {
      if (String(url).endsWith("/auth/refresh")) return response(rotatedTokens("new"));
      if (String(url).endsWith("/users/me")) throw new Error("network unavailable");
      throw new Error("Unexpected mocked endpoint");
    });
    const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js");

    const result = await testSingleConnection("cline-1");

    expect(result.valid).toBe(false);
    expect(result.error).toBe("network unavailable");
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("cline-1", expect.objectContaining({
      accessToken: "access-new", refreshToken: "refresh-new", lastRefreshAt: expect.any(String),
    }));
  });

  it("refreshes two different accounts independently without sharing their tokens", async () => {
    fetch.mockImplementation(async (url, init) => {
      const { refreshToken } = JSON.parse(init.body);
      if (refreshToken === "old-refresh-a") return response(rotatedTokens("a"));
      if (refreshToken === "old-refresh-b") return response(rotatedTokens("b"));
      throw new Error("Unexpected mocked refresh token");
    });
    const { refreshProviderCredentials } = await import("open-sse/services/oauthCredentialManager.js");

    const [a, b] = await Promise.all([
      refreshProviderCredentials("cline", { connectionId: "account-a", refreshToken: "old-refresh-a" }, null),
      refreshProviderCredentials("cline", { connectionId: "account-b", refreshToken: "old-refresh-b" }, null),
    ]);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(a.accessToken).toBe("access-a");
    expect(a.refreshToken).toBe("refresh-a");
    expect(b.accessToken).toBe("access-b");
    expect(b.refreshToken).toBe("refresh-b");
  });
});
