import { beforeEach, describe, expect, it, vi } from "vitest";

const fx = vi.hoisted(() => ({
  settings: {},
  keys: {},
  credentials: {},
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  handleChatCore: vi.fn(),
  getClaudeCodeContinuation: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => fx.settings }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: async (key) => fx.keys[key] || null }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: fx.getProviderCredentials,
  markAccountUnavailable: fx.markAccountUnavailable,
  clearAccountError: vi.fn(),
  extractApiKey: (request) => request.headers.get("x-api-key") || request.headers.get("authorization")?.replace(/^Bearer /, "") || null,
  isValidApiKey: async (key) => !!fx.keys[key]?.isActive,
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: async (model) => ({ provider: model.slice(0, model.indexOf("/")), model: model.slice(model.indexOf("/") + 1) }),
  getComboModels: async () => null,
}));
vi.mock("@/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: async () => null,
  enforceKeyAccess: async () => null,
  filterAdapterModels: async (_context, models) => models,
  extractClientApiKey: (request) => request.headers.get("x-api-key") || request.headers.get("authorization")?.replace(/^Bearer /, "") || null,
}));
vi.mock("@/sse/services/autoCombo.js", () => ({ resolveAutoCombo: async () => null }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_provider, credentials) => credentials,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("@/sse/services/antigravityQuota.js", () => ({
  handleAntigravityQuotaError: vi.fn(), clearAntigravityStrikes: vi.fn(),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: fx.handleChatCore }));
vi.mock("open-sse/shared/claudeCode/sessions.js", () => ({ getClaudeCodeContinuation: fx.getClaudeCodeContinuation }));
vi.mock("open-sse/services/capacityAdapter.js", () => ({
  augmentModelsWithCapacityAdapter: (models) => models,
  withCapacityAdapterStripping: (handler) => handler,
  getActiveAdapterStrategy: () => "fallback",
}));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://127.0.0.1:8787" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn() }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), maskKey: vi.fn() }));

const { handleChat } = await import("@/sse/handlers/chat.js");
const { resetAutoComboHealth, getAutoComboHealth } = await import("open-sse/services/autoComboHealth.js");
const provider = "anthropic-compatible-test";
const model = `${provider}/custom-model`;

function request(headers = {}, messages = [{ role: "user", content: "Hello" }]) {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-9router-client-mode": "harness", ...headers },
    body: JSON.stringify({ model, max_tokens: 100, messages }),
  });
}

function success() {
  return { success: true, response: Response.json({ type: "message", content: [{ type: "text", text: "Hello" }] }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAutoComboHealth();
  fx.settings = { requireApiKey: false, probeAwareRouting: false };
  fx.keys = {
    "secret-a": { id: "key-a", isActive: true, access: { restricted: false } },
    "secret-b": { id: "key-b", isActive: true, access: { restricted: false } },
  };
  fx.credentials = { connectionId: "account-a", providerSpecificData: { executionMode: "claude-code" } };
  fx.getProviderCredentials.mockImplementation(async (_provider, _excluded, _model, options) => ({
    ...fx.credentials,
    connectionId: options.preferredConnectionId || fx.credentials.connectionId,
  }));
  fx.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
  fx.getClaudeCodeContinuation.mockReturnValue(null);
  fx.handleChatCore.mockImplementation(async () => success());
});

describe("Claude Code runtime chat ownership and account affinity", () => {
  it("uses the active key's database ID and passes bridge headers to core and credentials", async () => {
    const response = await handleChat(request({
      "x-api-key": "secret-a", "x-9router-session-id": " session-a ", "x-9router-client-mode": "harness",
    }));
    expect(response.status).toBe(200);
    expect(fx.getClaudeCodeContinuation).toHaveBeenCalledWith(expect.objectContaining({ model }), {
      ownerId: "api-key:key-a", provider, conversationId: "session-a",
    });
    const args = fx.handleChatCore.mock.calls[0][0];
    expect(args).toMatchObject({ runtimeOwnerId: "api-key:key-a", runtimeConversationId: "session-a", clientMode: "harness" });
    expect(args.credentials).toMatchObject({ runtimeOwnerId: "api-key:key-a", runtimeConversationId: "session-a", clientMode: "harness", runtimeRequestUrl: "http://localhost/v1/messages" });
    expect(args.runtimeOwnerId).not.toContain("secret-a");
  });

  it("isolates keys sharing a client conversation ID", async () => {
    await handleChat(request({ authorization: "Bearer secret-a", "x-9router-session-id": "shared" }));
    await handleChat(request({ authorization: "Bearer secret-b", "x-9router-session-id": "shared" }));
    expect(fx.getClaudeCodeContinuation.mock.calls.map((call) => call[1].ownerId)).toEqual(["api-key:key-a", "api-key:key-b"]);
  });

  it("uses a stable explicit anonymous scope when API keys are optional", async () => {
    await handleChat(request({ "x-9router-session-id": "local" }));
    await handleChat(request({ "x-9router-session-id": "local", "x-9router-owner-id": "key-a" }));
    expect(fx.getClaudeCodeContinuation.mock.calls.map((call) => call[1].ownerId)).toEqual(["anonymous:local", "anonymous:local"]);
  });

  it.each(["unknown", "inactive"])("does not authenticate a %s presented key as a runtime owner", async (key) => {
    fx.keys.inactive = { id: "key-inactive", isActive: false };
    await handleChat(request({ "x-api-key": key }));
    expect(fx.handleChatCore.mock.calls[0][0].runtimeOwnerId).toBe("anonymous:local");
  });

  it("keeps recognized Claude Code direct despite an explicit harness declaration", async () => {
    await handleChat(request({ "user-agent": "claude-cli/2.0.0", "x-9router-client-mode": "harness" }));
    expect(fx.getClaudeCodeContinuation).not.toHaveBeenCalled();
    expect(fx.handleChatCore.mock.calls[0][0].clientMode).toBe("claude-code");
  });

  it.each(["direct", "claude-code"])("skips runtime state for explicit %s mode", async (clientMode) => {
    await handleChat(request({ "x-9router-client-mode": clientMode }));
    expect(fx.getClaudeCodeContinuation).not.toHaveBeenCalled();
    expect(fx.handleChatCore.mock.calls[0][0].clientMode).toBe(clientMode);
  });

  it("keeps an unknown API client direct even when it presents a session header", async () => {
    await handleChat(request({ "x-9router-client-mode": "", "x-9router-session-id": "unrecognized-session" }));
    expect(fx.getClaudeCodeContinuation).not.toHaveBeenCalled();
    expect(fx.handleChatCore.mock.calls[0][0]).toMatchObject({ clientMode: null, runtimeConversationId: "unrecognized-session" });
    expect(fx.handleChatCore.mock.calls[0][0].credentials.runtimeSessionId).toBeUndefined();
  });

  it("rejects unknown client modes before accessing an upstream account", async () => {
    const response = await handleChat(request({ "x-9router-client-mode": "shell" }));
    expect(response.status).toBe(400);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(fx.getProviderCredentials).not.toHaveBeenCalled();
    expect(getAutoComboHealth()).toEqual([]);
  });

  it("pins suspended tool invocations to their original provider account", async () => {
    fx.getClaudeCodeContinuation.mockReturnValue({ connectionId: "account-b", sessionId: "runtime-b" });
    await handleChat(request({ "x-api-key": "secret-a" }));
    expect(fx.getProviderCredentials).toHaveBeenCalledWith(provider, expect.any(Set), "custom-model", {
      requestedModel: "custom-model", preferredConnectionId: "account-b",
    });
    expect(fx.handleChatCore.mock.calls[0][0].credentials).toMatchObject({ connectionId: "account-b", runtimeSessionId: "runtime-b" });
  });

  it("finds existing continuations even when the runtime configuration was disabled", async () => {
    fx.credentials.providerSpecificData.executionMode = "direct";
    fx.getClaudeCodeContinuation.mockReturnValue({ connectionId: "account-a", sessionId: "runtime-a" });
    await handleChat(request());
    expect(fx.handleChatCore.mock.calls[0][0].credentials).toMatchObject({ runtimeSessionId: "runtime-a", providerSpecificData: { executionMode: "direct" } });
  });

  it("leaves a normal custom API tool-result history on its direct route", async () => {
    const actual = await vi.importActual("open-sse/shared/claudeCode/sessions.js");
    fx.getClaudeCodeContinuation.mockImplementation(actual.getClaudeCodeContinuation);
    fx.credentials.providerSpecificData.executionMode = "direct";
    const response = await handleChat(request({}, [
      { role: "user", content: "Check the file" },
      { role: "assistant", content: [{ type: "tool_use", id: "foreign-tool-a", name: "read", input: { file: "app.js" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "foreign-tool-a", content: "File contents" }] },
    ]));
    expect(response.status).toBe(200);
    expect(fx.handleChatCore).toHaveBeenCalledTimes(1);
    expect(fx.handleChatCore.mock.calls[0][0].credentials.runtimeSessionId).toBeUndefined();
  });

  it.each([null, { allRateLimited: true }, { connectionId: "different-account" }])(
    "rejects an unavailable continuation account instead of using another account (%j)", async (credentials) => {
      fx.getClaudeCodeContinuation.mockReturnValue({ connectionId: "account-b", sessionId: "runtime-b" });
      fx.getProviderCredentials.mockResolvedValue(credentials);
      const response = await handleChat(request());
      expect(response.status).toBe(409);
      expect(response.headers.get("x-should-retry")).toBe("false");
      expect(fx.handleChatCore).not.toHaveBeenCalled();
    },
  );

  it("returns broker errors before account selection with fallback disabled", async () => {
    fx.getClaudeCodeContinuation.mockImplementation(() => {
      throw Object.assign(new Error("Tool result does not belong to this session"), { statusCode: 403 });
    });
    const response = await handleChat(request());
    expect(response.status).toBe(403);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(fx.getProviderCredentials).not.toHaveBeenCalled();
  });

  it("does not retry or mark the account unavailable when a continuation fails", async () => {
    fx.getClaudeCodeContinuation.mockReturnValue({ connectionId: "account-a", sessionId: "runtime-a" });
    fx.handleChatCore.mockResolvedValue({ success: false, status: 502, error: "Runtime stopped", response: Response.json({ error: { message: "Runtime stopped" } }, { status: 502 }) });
    const response = await handleChat(request());
    expect(response.status).toBe(502);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(fx.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(fx.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("honors a runtime's no-retry header even on its initial generation", async () => {
    fx.handleChatCore.mockResolvedValue({ success: false, status: 502, error: "Runtime stopped", response: Response.json({ error: { message: "Runtime stopped" } }, { status: 502, headers: { "x-should-retry": "false" } }) });
    const response = await handleChat(request());
    expect(response.status).toBe(502);
    expect(fx.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(fx.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("converts a thrown continuation failure into a response with fallback disabled", async () => {
    fx.getClaudeCodeContinuation.mockReturnValue({ connectionId: "account-a", sessionId: "runtime-a" });
    fx.handleChatCore.mockRejectedValue(new Error("Private internal worker failure"));
    const response = await handleChat(request());
    expect(response.status).toBe(502);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(await response.text()).not.toContain("Private internal");
    expect(fx.getProviderCredentials).toHaveBeenCalledTimes(1);
  });

  it("enforces required authentication before any runtime lookup", async () => {
    fx.settings.requireApiKey = true;
    const response = await handleChat(request());
    expect(response.status).toBe(401);
    expect(fx.getClaudeCodeContinuation).not.toHaveBeenCalled();
    expect(fx.getProviderCredentials).not.toHaveBeenCalled();
  });
});
