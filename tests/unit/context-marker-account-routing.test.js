import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise chat dispatch, model resolution, and account filtering together.
// Stub persistence and upstream execution so no account data or network is used.
const state = vi.hoisted(() => ({
  connections: [],
  aliases: {},
  combos: {},
  settings: {},
  handleChatCore: vi.fn(),
  resolveAutoCombo: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => state.settings,
  getModelAliases: async () => state.aliases,
  getComboByName: async (name) => state.combos[name] || null,
  getProviderNodes: async () => [],
  getProviderConnections: async ({ provider }) => state.connections.filter((c) => c.provider === provider),
  getProxyPools: async () => [],
  updateProviderConnection: vi.fn(),
  validateApiKey: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: async () => ({}),
}));
vi.mock("@/lib/modelProbe/routingHints", () => ({
  getProbeHints: async () => ({}),
  orderConnectionsByProbe: vi.fn(),
  recordLiveOutcome: async () => {},
}));
vi.mock("@/sse/services/antigravityQuota.js", () => ({
  getAntigravityQuotaCache: () => new Map(),
  handleAntigravityQuotaError: vi.fn(),
  clearAntigravityStrikes: vi.fn(),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_provider, credentials) => credentials,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: state.handleChatCore }));
vi.mock("@/sse/services/autoCombo.js", () => ({ resolveAutoCombo: state.resolveAutoCombo }));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://127.0.0.1:8787" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn() }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), maskKey: vi.fn(),
}));

const { handleChat } = await import("@/sse/handlers/chat.js");
const { resetAutoComboHealth } = await import("open-sse/services/autoComboHealth.js");

function connection(id, provider, enabledModels) {
  return {
    id, provider, isActive: true, authType: "oauth", accessToken: `token-${id}`,
    providerSpecificData: enabledModels ? { enabledModels } : {},
  };
}

function request(model) {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "Write a short sentence about rain." }] }),
  });
}

async function dispatch(model) {
  const response = await handleChat(request(model));
  expect(response.status).toBe(200);
  expect(state.handleChatCore).toHaveBeenCalledTimes(1);
  return state.handleChatCore.mock.calls[0][0];
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAutoComboHealth();
  state.aliases = {};
  state.combos = {};
  state.settings = { requireApiKey: false, probeAwareRouting: false };
  state.connections = [
    connection("codex-base", "codex", ["gpt-6-astra", "gpt-6-sol"]),
    connection("codex-extended", "codex", ["gpt-6-astra[1m]", "gpt-6-sol[1m]"]),
    connection("claude-account", "claude"),
  ];
  state.resolveAutoCombo.mockResolvedValue(null);
  state.handleChatCore.mockImplementation(async () => ({
    success: true,
    response: new Response(JSON.stringify({ choices: [{ message: { content: "Rain falls." } }] }), {
      headers: { "Content-Type": "application/json" },
    }),
  }));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request"); }));
});

afterEach(() => vi.unstubAllGlobals());

describe("context markers across chat routing", () => {
  it.each(["cc/claude-opus-5[1m]", "writing-model[1m]"])(
    "forwards the Claude context marker after resolving %s",
    async (model) => {
      state.aliases = { "writing-model": "cc/claude-opus-5" };
      state.settings.providerOverrides = { claude: { headers: { "X-Example": "custom" } } };

      const dispatched = await dispatch(model);

      expect(dispatched.modelInfo).toEqual({ provider: "claude", model: "claude-opus-5" });
      expect(dispatched.body.model).toBe("claude/claude-opus-5");
      expect(dispatched.credentials).toMatchObject({ connectionId: "claude-account", contextMarker: "1m" });
      expect(dispatched.providerOverrides).toEqual(state.settings.providerOverrides.claude);
    },
  );

  it("selects the extended Codex account for a marked provider alias", async () => {
    const dispatched = await dispatch("cx/gpt-6-astra[1m]");

    expect(dispatched.connectionId).toBe("codex-extended");
    expect(dispatched.modelInfo).toEqual({ provider: "codex", model: "gpt-6-astra" });
    expect(dispatched.credentials.contextMarker).toBe("1m");
  });

  it("selects the base Codex account when the client omits the marker", async () => {
    const dispatched = await dispatch("cx/gpt-6-astra");

    expect(dispatched.connectionId).toBe("codex-base");
    expect(dispatched.credentials).not.toHaveProperty("contextMarker");
  });

  it.each(["fallback", "fusion"])("uses the resolved seat model for a marked %s combo", async (strategy) => {
    state.combos = { writing: { name: "writing", models: ["cx/gpt-6-sol"] } };
    state.settings.comboStrategy = strategy;

    const dispatched = await dispatch("writing[1m]");

    expect(dispatched.connectionId).toBe("codex-extended");
    expect(dispatched.modelInfo).toEqual({ provider: "codex", model: "gpt-6-sol" });
    expect(dispatched.credentials.contextMarker).toBe("1m");
    expect(state.resolveAutoCombo).not.toHaveBeenCalled();
  });

  it("retains the marker through nested combo callbacks", async () => {
    state.combos = {
      outer: { name: "outer", models: ["inner"] },
      inner: { name: "inner", models: ["cx/gpt-6-sol"] },
    };

    const dispatched = await dispatch("outer[1m]");

    expect(dispatched.connectionId).toBe("codex-extended");
    expect(dispatched.credentials.contextMarker).toBe("1m");
  });

  it("retains the marker when a bare model expands into an auto-combo", async () => {
    state.resolveAutoCombo.mockResolvedValue({ models: ["cx/gpt-6-astra"], benched: [] });

    const dispatched = await dispatch("gpt-6-astra[1m]");

    expect(state.resolveAutoCombo).toHaveBeenCalledWith("gpt-6-astra", state.settings);
    expect(dispatched.connectionId).toBe("codex-extended");
    expect(dispatched.credentials.contextMarker).toBe("1m");
  });
});
