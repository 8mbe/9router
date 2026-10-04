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
const { resetAutoComboHealth, getAutoComboHealth, markAutoComboUnavailable } = await import("open-sse/services/autoComboHealth.js");

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

describe("model health across chat routing", () => {
  it.each(["fallback", "fusion"])("records concrete members of a %s combo", async (strategy) => {
    state.combos = { writing: { name: "writing", models: ["cc/claude-opus-5"] } };
    state.settings.comboStrategy = strategy;

    await handleChat(request("writing"));

    expect(getAutoComboHealth()).toEqual([expect.objectContaining({ member: "cc/claude-opus-5", status: "working" })]);
  });

  it("records nested model outcomes without recording the combo name", async () => {
    state.combos = {
      outer: { models: ["inner"] },
      inner: { models: ["cc/claude-opus-5"] },
    };

    await handleChat(request("outer"));

    expect(getAutoComboHealth().map(({ member }) => member)).toEqual(["cc/claude-opus-5"]);
  });

  it("preserves automatic health ordering even when an older setting requests round-robin", async () => {
    state.settings.autoComboStrategy = "round-robin";
    state.resolveAutoCombo.mockResolvedValue({ models: ["cc/claude-opus-5", "cx/gpt-6-astra"], benched: [] });

    await handleChat(request("claude-opus-5"));
    await handleChat(request("claude-opus-5"));

    expect(state.handleChatCore.mock.calls.map(([args]) => args.modelInfo.provider)).toEqual(["claude", "claude"]);
  });

  it("waits for a successful SSE body before clearing previous failure", async () => {
    const content = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n';
    markAutoComboUnavailable("cc/claude-opus-5", 503, "old error");
    state.handleChatCore.mockResolvedValue({ success: true, response: new Response(content, { headers: { "Content-Type": "text/event-stream" } }) });

    const response = await handleChat(request("cc/claude-opus-5"));
    expect(getAutoComboHealth()[0].status).toBe("not_working");
    expect(await response.text()).toBe(content);
    expect(getAutoComboHealth()[0].status).toBe("working");
  });

  it.each([
    'event: error\ndata: {"type":"error","error":{"message":"model unavailable","status":503}}\n\n',
    'data: {"type":"response.failed","response":{"error":{"message":"provider unavailable"}}}\n\n',
  ])("retains embedded stream failures without changing response bytes", async (content) => {
    state.handleChatCore.mockResolvedValue({ success: true, response: new Response(content, { headers: { "Content-Type": "text/event-stream" } }) });

    const response = await handleChat(request("cc/claude-opus-5"));

    expect(await response.text()).toBe(content);
    expect(getAutoComboHealth()[0]).toMatchObject({ status: "not_working", lastStatus: expect.any(Number) });
  });

  it("accepts normal Responses token-limit completion as a working stream", async () => {
    const content = 'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n';
    state.handleChatCore.mockResolvedValue({ success: true, response: new Response(content, { headers: { "Content-Type": "text/event-stream" } }) });

    await (await handleChat(request("cc/claude-opus-5"))).text();

    expect(getAutoComboHealth()[0].status).toBe("working");
  });

  it("does not infer success when the client cancels a stream after the first event", async () => {
    const upstream = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('event: message_start\ndata: {"type":"message_start"}\n\n')); },
    });
    state.handleChatCore.mockResolvedValue({ success: true, response: new Response(upstream, { headers: { "Content-Type": "text/event-stream" } }) });
    const response = await handleChat(request("cc/claude-opus-5"));
    const reader = response.body.getReader();
    await reader.read();
    const pendingRead = reader.read();

    await reader.cancel("client disconnected");
    await pendingRead;

    expect(getAutoComboHealth()).toEqual([]);
  });

  it("passes oversized SSE data through without claiming fully observed success", async () => {
    const content = `data: {"choices":[]}\n\ndata: ${"x".repeat(300000)}\n\ndata: [DONE]\n\n`;
    state.handleChatCore.mockResolvedValue({ success: true, response: new Response(content, { headers: { "Content-Type": "text/event-stream" } }) });

    const response = await handleChat(request("cc/claude-opus-5"));

    expect(await response.text()).toBe(content);
    expect(getAutoComboHealth()).toEqual([]);
  });

  it("does not demote a model for malformed request errors", async () => {
    state.handleChatCore.mockResolvedValue({ success: false, status: 400, error: "context length exceeded", response: new Response('{"error":{"message":"context length exceeded"}}', { status: 400 }) });

    const response = await handleChat(request("cc/claude-opus-5"));

    expect(response.status).toBe(400);
    expect(getAutoComboHealth()).toEqual([]);
  });

  it("records thrown dispatch failures without swallowing the error", async () => {
    state.handleChatCore.mockRejectedValue(new Error("upstream socket closed"));

    await expect(handleChat(request("cc/claude-opus-5"))).rejects.toThrow("upstream socket closed");

    expect(getAutoComboHealth()[0]).toMatchObject({ status: "not_working", lastStatus: 502, lastError: "upstream socket closed" });
  });

  it("converts an explicit error in JSON HTTP 200 into a failed combo attempt", async () => {
    state.combos = { writing: { models: ["cc/claude-opus-5", "cx/gpt-6-astra"] } };
    state.handleChatCore.mockImplementation(async ({ modelInfo }) => ({
      success: true,
      response: new Response(JSON.stringify(modelInfo.provider === "claude"
        ? { error: { message: "provider unavailable", status: 503 } }
        : { choices: [{ message: { content: "Good response" } }] }), { headers: { "Content-Type": "application/json" } }),
    }));

    const response = await handleChat(request("writing"));

    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe("Good response");
    expect(state.handleChatCore.mock.calls.map(([args]) => args.modelInfo.provider)).toEqual(["claude", "codex"]);
    expect(getAutoComboHealth().find(({ member }) => member === "cc/claude-opus-5")).toMatchObject({ status: "not_working", lastStatus: 503 });
    expect(getAutoComboHealth().find(({ member }) => member === "cx/gpt-6-astra").status).toBe("working");
  });
});
