import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connections: [],
  getSettings: vi.fn(),
  updateProviderConnection: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async () => mocks.connections),
  getSettings: mocks.getSettings,
  getProxyPools: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnection: mocks.updateProviderConnection,
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({
    connectionProxyEnabled: true,
    connectionProxyUrl: "http://brd-customer-test-zone-test:secret@brd.superproxy.io:33335",
    strictProxy: true,
  })),
  pickProxyPoolId: vi.fn(),
}));
vi.mock("@/lib/modelProbe/routingHints", () => ({
  getProbeHints: vi.fn(async () => ({})),
  orderConnectionsByProbe: vi.fn(connections => ({ pool: connections })),
  recordLiveOutcome: vi.fn(async () => {}),
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { getProviderCredentials, markAccountUnavailable, clearAccountError } = await import("@/sse/services/auth.js");
const {
  acquireCustomApiSession, clearCustomApiSessionStore, getPinnedCustomApiConnectionId,
  isCustomApiConnectionDraining, markCustomApiSessionDraining,
} = await import("open-sse/utils/customApiSession.js");
const provider = "openai-compatible-chat-pinning";
const lease = credentials => acquireCustomApiSession({
  provider, connectionId: credentials.connectionId,
  providerSpecificData: credentials.providerSpecificData,
  proxyUrl: credentials.providerSpecificData.connectionProxyUrl,
});

beforeEach(() => {
  clearCustomApiSessionStore();
  vi.clearAllMocks();
  mocks.connections = ["a", "b"].map((id, index) => ({
    id, provider, apiKey: `key-${id}`, priority: index + 1,
    providerSpecificData: { customApiSessionPinning: true },
  }));
  mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin", stickyRoundRobinLimit: 1, probeAwareRouting: false });
  mocks.updateProviderConnection.mockImplementation(async (id, updates) => {
    Object.assign(mocks.connections.find(c => c.id === id), updates);
  });
});

describe("custom API account pinning through credential selection", () => {
  it("keeps a pinned account across normal completions instead of rotating keys", async () => {
    const first = await getProviderCredentials(provider, null, "model");
    expect(first.connectionId).toBe("a");
    const firstLease = lease(first);
    firstLease.release();
    const next = await getProviderCredentials(provider, null, "model");
    expect(next.connectionId).toBe("a");
    expect(lease(next).sessionId).toBe(firstLease.sessionId);
    expect(next.providerSpecificData.strictProxy).toBe(true);
  });

  it("switches to a separate account/session after quota exhaustion while old streams drain", async () => {
    const first = await getProviderCredentials(provider, null, "model");
    const firstLease = lease(first);
    const overlappingLease = lease(first);
    await markAccountUnavailable("a", 429, "Quota exhausted", provider, "model");
    expect(isCustomApiConnectionDraining(provider, "a")).toBe(true);
    const next = await getProviderCredentials(provider, null, "another-model");
    expect(next.connectionId).toBe("b");
    const nextLease = lease(next);
    expect(nextLease.sessionId).not.toBe(firstLease.sessionId);
    firstLease.release();
    expect(isCustomApiConnectionDraining(provider, "a")).toBe(true);
    overlappingLease.release();
    expect(isCustomApiConnectionDraining(provider, "a")).toBe(false);
    expect(getPinnedCustomApiConnectionId(provider)).toBe("b");
    expect((await getProviderCredentials(provider, null, "another-model")).connectionId).toBe("b");
    nextLease.release();
  });

  it("does not rotate a pin for a non-fallback request error", async () => {
    const first = await getProviderCredentials(provider, null, "model");
    lease(first).release();
    await markAccountUnavailable("a", 400, "Invalid request body", provider, "model");
    expect(getPinnedCustomApiConnectionId(provider)).toBe("a");
  });

  it("does not let an older successful stream clear a newer quota lock", async () => {
    Object.assign(mocks.connections[0], {
      testStatus: "unavailable", lastError: "Earlier transient error",
      lastErrorAt: "2000-01-01T00:00:00.000Z", modelLock_model: "2000-01-01T00:00:00.000Z",
    });
    const first = await getProviderCredentials(provider, null, "model");
    // The real database returns an independent object for each read.
    first._connection = structuredClone(first._connection);
    const firstLease = lease(first);
    await markAccountUnavailable("a", 429, "Quota exhausted", provider, "model");
    const lockedUntil = mocks.connections[0].modelLock_model;
    firstLease.release();
    await clearAccountError("a", first, "model", provider);
    expect(mocks.connections[0].modelLock_model).toBe(lockedUntil);
    expect(mocks.connections[0].testStatus).toBe("unavailable");
  });

  it("drains a disabled account and selects another without affecting its active stream", async () => {
    const first = await getProviderCredentials(provider, null, "model");
    const firstLease = lease(first);
    mocks.connections = mocks.connections.filter(c => c.id !== "a");
    expect((await getProviderCredentials(provider, null, "model")).connectionId).toBe("b");
    expect(isCustomApiConnectionDraining(provider, "a")).toBe(true);
    firstLease.release();
    expect(getPinnedCustomApiConnectionId(provider)).toBe("b");
  });

  it("does not allocate a request lease just because credentials were read", async () => {
    await getProviderCredentials(provider, null, "model");
    markCustomApiSessionDraining(provider, "a");
    expect(isCustomApiConnectionDraining(provider, "a")).toBe(false);
  });

  it("leaves ordinary round-robin routing unchanged with pinning disabled", async () => {
    for (const connection of mocks.connections) connection.providerSpecificData.customApiSessionPinning = false;
    expect((await getProviderCredentials(provider, null, "model")).connectionId).toBe("a");
    expect((await getProviderCredentials(provider, null, "model")).connectionId).toBe("b");
    expect(getPinnedCustomApiConnectionId(provider)).toBeNull();
  });

  it("serializes concurrent selections onto the same pinned account", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => getProviderCredentials(provider, null, "model")));
    expect(results.map(result => result.connectionId)).toEqual(["a", "a", "a", "a", "a"]);
  });
});
