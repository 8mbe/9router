import { beforeEach, describe, expect, it, vi } from "vitest";
import { shouldUseClaudeCodeRuntime } from "../../open-sse/shared/claudeCode/policy.js";
import { detectClientTool, isClaudeCodeClient } from "../../open-sse/utils/clientDetector.js";
import { handleComboChat } from "../../open-sse/services/combo.js";
import { assertNoClaudeCodeLoop, claudeCodeRuntimeHop } from "../../open-sse/shared/claudeCode/loopGuard.js";

const { execute, chooseExecutor } = vi.hoisted(() => ({ execute: vi.fn(), chooseExecutor: vi.fn() }));
vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: (...args) => { chooseExecutor(...args); return { noAuth: true, execute }; },
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({ logClientRawRequest() {}, logRawRequest() {}, logTargetRequest() {}, logProviderResponse() {}, logConvertedResponse() {}, logError() {} }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest() {}, appendRequestLog: async () => {}, saveRequestDetail: async () => {}, saveRequestUsage: async () => {},
}));
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const provider = "anthropic-compatible-example";
const credentials = () => ({ apiKey: "upstream-test", connectionId: "connection-a", providerSpecificData: { executionMode: "claude-code", baseUrl: "https://api.example.test/v1" } });

beforeEach(() => {
  vi.clearAllMocks();
  execute.mockResolvedValue({
    response: new Response(JSON.stringify({ id: "msg_test", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 4, output_tokens: 1 } }), { headers: { "content-type": "application/json", "x-9router-session-id": "test-session" } }),
    url: "https://api.example.test/v1/messages", headers: {}, responseFormat: "claude",
  });
});

describe("Claude Code runtime policy", () => {
  it("never nests native Claude Code, even with conflicting routing headers", () => {
    const creds = credentials();
    creds.rawHeaders = { "user-agent": "claude-cli/2.1.295", "x-initiator": "user", "x-9router-client-mode": "harness" };
    expect(detectClientTool(creds.rawHeaders)).toBe("github-copilot");
    expect(isClaudeCodeClient(creds.rawHeaders)).toBe(true);
    expect(shouldUseClaudeCodeRuntime(provider, { credentials: creds, clientMode: "harness", clientTool: "github-copilot" })).toBe(false);
  });

  it("requires an enabled custom connection and a declared or recognized harness", () => {
    const creds = credentials();
    expect(shouldUseClaudeCodeRuntime(provider, { credentials: creds })).toBe(false);
    expect(shouldUseClaudeCodeRuntime(provider, { credentials: creds, clientMode: "harness" })).toBe(true);
    expect(shouldUseClaudeCodeRuntime(provider, { credentials: creds, clientTool: "codex" })).toBe(true);
    expect(shouldUseClaudeCodeRuntime(provider, { credentials: creds, clientMode: "direct", clientTool: "codex" })).toBe(false);
    expect(shouldUseClaudeCodeRuntime("claude", { credentials: creds, clientMode: "harness" })).toBe(false);
    creds.providerSpecificData.executionMode = "direct";
    expect(shouldUseClaudeCodeRuntime(provider, { credentials: creds, clientMode: "harness" })).toBe(false);
  });

  it("preserves the normal body-based client detection order", () => {
    const headers = { "user-agent": "claude-cli/2.1.295" };
    expect(detectClientTool(headers, { userAgent: "antigravity" })).toBe("antigravity");
    expect(isClaudeCodeClient(headers)).toBe(true);
    expect(shouldUseClaudeCodeRuntime(provider, { credentials: { ...credentials(), rawHeaders: headers }, clientTool: "antigravity" })).toBe(false);
  });

  it("treats a Claude CLI signature as direct even when a proxy rewrites its user agent", () => {
    const creds = credentials();
    creds.rawHeaders = { "user-agent": "proxy-client", "x-app": "cli", "x-initiator": "user" };
    expect(detectClientTool(creds.rawHeaders)).toBe("github-copilot");
    expect(isClaudeCodeClient(creds.rawHeaders)).toBe(true);
    expect(shouldUseClaudeCodeRuntime(provider, { credentials: creds, clientMode: "harness" })).toBe(false);
  });

  it("blocks a runtime request returning through an alias of the router", () => {
    expect(() => assertNoClaudeCodeLoop(new Headers({ "x-9router-runtime-hop": claudeCodeRuntimeHop() }))).toThrow("loops back");
    expect(() => assertNoClaudeCodeLoop({ "x-9router-runtime-hop": "another-router" })).not.toThrow();
  });
});

describe("native Anthropic bridge dispatch", () => {
  it.each([
    ["direct", undefined], [undefined, undefined],
    ["direct", "direct"], ["direct", "claude-code"],
  ])("keeps normal Claude-client normalization when connection mode is %s and client override is %s", async (executionMode, clientMode) => {
    const creds = credentials();
    if (executionMode === undefined) delete creds.providerSpecificData.executionMode;
    else creds.providerSpecificData.executionMode = executionMode;
    const body = {
      model: "routed-model", max_tokens: 128, stream: false,
      thinking: { type: "adaptive" }, output_config: { effort: "high" },
      system: [{ type: "text", text: "client instructions", cache_control: { type: "ephemeral" } }],
      tools: [
        { name: "mcp__tavily__tavily_search", input_schema: { type: "object", properties: {} } },
        { name: "WebSearch", input_schema: { type: "object", properties: {} } },
      ],
      messages: [
        { role: "user", content: "hello" },
        { role: "system", content: "mid-conversation reminder" },
        { role: "user", content: "continue" },
      ],
    };
    const result = await handleChatCore({
      body, modelInfo: { provider, model: "claude-haiku-4-5" }, credentials: creds,
      clientMode, sourceFormatOverride: "claude", connectionId: "connection-a",
      clientRawRequest: { endpoint: "/v1/messages", body, headers: { "user-agent": "claude-cli/2.1.295" } },
    });
    expect(result.success).toBe(true);
    const sent = execute.mock.calls[0][0];
    expect(sent.body.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
    expect(sent.body.output_config).toBeUndefined();
    expect(sent.body.messages.some(message => message.role === "system")).toBe(false);
    expect(JSON.stringify(sent.body.messages)).toContain("mid-conversation reminder");
    expect(sent.body.tools.map(tool => tool.name)).toEqual(["mcp__tavily__tavily_search"]);
    expect(sent.body.system.at(-1).cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(shouldUseClaudeCodeRuntime(provider, chooseExecutor.mock.calls[0][1])).toBe(false);
  });

  it("restores provider thinking overrides in normal mode", async () => {
    const creds = credentials();
    creds.providerSpecificData.executionMode = "direct";
    await handleChatCore({
      body: { messages: [{ role: "user", content: "hello" }], stream: false },
      modelInfo: { provider, model: "claude-sonnet-4-6" }, credentials: creds,
      sourceFormatOverride: "claude", providerThinking: { mode: "on" },
      clientRawRequest: { headers: { "user-agent": "claude-cli/2.1.295" } },
    });
    expect(execute.mock.calls[0][0].body.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
  });

  it.each(["direct", "claude-code"])("applies configured token savers only in normal mode (%s)", async executionMode => {
    const creds = credentials();
    creds.providerSpecificData.executionMode = executionMode;
    const body = { messages: [{ role: "user", content: "hello" }], system: "client instructions", stream: false };
    await handleChatCore({
      body, modelInfo: { provider, model: "claude-sonnet-4-6" }, credentials: creds,
      sourceFormatOverride: "claude", cavemanEnabled: true, cavemanLevel: "full",
      clientRawRequest: { headers: { "user-agent": "claude-cli/2.1.295" } },
    });
    const sent = execute.mock.calls[0][0].body;
    expect(JSON.stringify(sent.system)).toContain("client instructions");
    if (executionMode === "direct") expect(sent.system).not.toEqual("client instructions");
    else expect(sent.system).toBe("client instructions");
  });

  it("uses strict native-client forwarding only on an enabled connection", async () => {
    await handleChatCore({
      body: { messages: [{ role: "user", content: "hello" }], stream: false },
      modelInfo: { provider, model: "claude-sonnet-4-6" }, credentials: credentials(),
      sourceFormatOverride: "claude", clientMode: "harness",
      clientRawRequest: { headers: { "user-agent": "claude-cli/2.1.295", "x-initiator": "user" } },
    });
    expect(chooseExecutor.mock.calls[0][1].clientTool).toBe("claude");
    expect(shouldUseClaudeCodeRuntime(provider, chooseExecutor.mock.calls[0][1])).toBe(false);
  });

  it.each(["native", "harness"])("preserves %s Messages fields despite enabled token savers and provider overrides", async mode => {
    const body = {
      model: "routed-model", max_tokens: 128, stream: false,
      system: [{ type: "text", text: "client instructions", cache_control: { type: "ephemeral" } }],
      tools: [{ name: "lookup", input_schema: { type: "object", properties: {} }, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] }],
    };
    const original = structuredClone(body);
    const result = await handleChatCore({
      body, modelInfo: { provider, model: "claude-sonnet-4-6" }, credentials: credentials(),
      sourceFormatOverride: "claude", clientMode: mode === "harness" ? "harness" : undefined,
      runtimeOwnerId: "api-key:a", connectionId: "connection-a",
      providerThinking: { mode: "on" }, rtkEnabled: true, headroomEnabled: true,
      cavemanEnabled: true, cavemanLevel: "high", ponytailEnabled: true, ponytailLevel: "high", pxpipeEnabled: true,
      clientRawRequest: { endpoint: "/v1/messages", body, headers: mode === "native" ? { "user-agent": "claude-cli/2.1.295" } : { "x-9router-client-mode": "harness" } },
    });
    expect(result.success).toBe(true);
    const sent = execute.mock.calls[0][0];
    expect(sent.body).toEqual({ ...original, model: "claude-sonnet-4-6" });
    expect(body).toEqual(original);
    expect(chooseExecutor.mock.calls[0][1].clientTool).toBe(mode === "native" ? "claude" : null);
    expect(sent.credentials.runtimeOwnerId).toBe("api-key:a");
    expect(result.response.headers.get("x-9router-session-id")).toBe("test-session");
  });

  it("rejects other wire formats instead of silently changing a bridge conversation", async () => {
    const result = await handleChatCore({
      body: { messages: [{ role: "user", content: "hello" }] },
      modelInfo: { provider, model: "claude-sonnet-4-6" }, credentials: credentials(),
      clientMode: "harness", sourceFormatOverride: "openai",
    });
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("x-should-retry")).toBe("false");
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves a bridge conflict status and prevents retry/fallback", async () => {
    execute.mockRejectedValue(Object.assign(new Error("Session has pending tools"), { statusCode: 409 }));
    const result = await handleChatCore({
      body: { messages: [{ role: "user", content: "hello" }] },
      modelInfo: { provider, model: "claude-sonnet-4-6" }, credentials: credentials(),
      clientMode: "harness", sourceFormatOverride: "claude",
    });
    expect(result.response.status).toBe(409);
    expect(result.response.headers.get("x-should-retry")).toBe("false");
  });

  it("does not forward a suspended session to HTTP when the runtime mode is disabled", async () => {
    const creds = credentials();
    creds.providerSpecificData.executionMode = "direct";
    creds.runtimeSessionId = "pending-session";
    const result = await handleChatCore({ body: { messages: [{ role: "user", content: "hello" }] }, modelInfo: { provider, model: "claude-sonnet-4-6" }, credentials: creds, clientMode: "harness", sourceFormatOverride: "claude" });
    expect(result.response.status).toBe(409);
    expect(result.response.headers.get("x-should-retry")).toBe("false");
    expect(execute).not.toHaveBeenCalled();
  });

  it("a combo respects the bridge's no-retry response", async () => {
    const response = new Response(JSON.stringify({ error: { message: "Session conflict" } }), { status: 409, headers: { "x-should-retry": "false" } });
    const single = vi.fn().mockResolvedValue(response);
    const result = await handleComboChat({ body: { messages: [] }, models: ["p/a", "p/b"], handleSingleModel: single, log: { info() {}, warn() {}, debug() {} }, comboName: "bridge", comboStrategy: "fallback" });
    expect(result).toBe(response);
    expect(single).toHaveBeenCalledTimes(1);
  });
});
