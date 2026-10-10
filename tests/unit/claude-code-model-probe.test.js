import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createWorker: vi.fn(),
  resolveProxy: vi.fn(async () => ({})),
}));

vi.mock("open-sse/shared/claudeCode/runtime.js", () => ({ createClaudeCodeWorker: mocks.createWorker }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: mocks.resolveProxy }));

const { probeClaudeCodeModel } = await import("@/lib/modelProbe/claudeCode.js");
const { probeConnectionModel, probeModelEndpoint } = await import("@/lib/modelProbe/probe.js");
const { claudeCodeRuntimeHop } = await import("open-sse/shared/claudeCode/loopGuard.js");

const connection = {
  id: "selected-key",
  provider: "anthropic-compatible-custom",
  apiKey: "selected-upstream-key",
  providerSpecificData: { baseUrl: "https://custom.test/v1", executionMode: "claude-code", authMode: "bearer" },
};

function events(model = "custom-model", text = "hello", blocks = [{ type: "text", text }]) {
  return [
    { type: "message_start", message: { id: "msg_probe", type: "message", role: "assistant", model, content: [], usage: { input_tokens: 8, output_tokens: 0 } } },
    ...blocks.flatMap((block, index) => [
      { type: "content_block_start", index, content_block: block.type === "text" ? { ...block, text: "" } : block },
      ...(block.type === "text" ? [{ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } }] : []),
      { type: "content_block_stop", index },
    ]),
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
}

function fakeWorker({ reply = true, result, streamEvents } = {}) {
  const worker = { close: vi.fn(async () => {}), sendUserMessage: vi.fn(), ready: Promise.resolve("native-session") };
  mocks.createWorker.mockImplementation(async (options) => {
    worker.sendUserMessage.mockImplementation(() => {
      if (!reply) return;
      for (const event of streamEvents || events(options.model)) options.onEvent(event);
      options.onMessage(result || { type: "result", subtype: "success", is_error: false });
    });
    return worker;
  });
  return worker;
}

beforeEach(() => {
  mocks.createWorker.mockReset();
  mocks.resolveProxy.mockReset().mockResolvedValue({});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("model checks honor the selected key's Claude Code mode", () => {
  it("uses the saved upstream, key, model and auth mode without a router fallback", async () => {
    const worker = fakeWorker();
    const direct = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Direct requests must not run"));
    const result = await probeConnectionModel(connection, "custom-model", { proxy: {} });

    expect(result).toMatchObject({ ok: true, error: null, status: 200 });
    expect(mocks.createWorker).toHaveBeenCalledWith(expect.objectContaining({
      model: "custom-model", upstreamBaseUrl: "https://custom.test/v1",
      apiKey: "selected-upstream-key", authMode: "bearer", tools: [], maxTokens: 1024,
      runtimeHop: claudeCodeRuntimeHop(), signal: expect.any(AbortSignal),
    }));
    expect(worker.sendUserMessage).toHaveBeenCalledWith("hi");
    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(direct).not.toHaveBeenCalled();
  });

  it.each([
    { provider: connection.provider, format: "claude", providerSpecificData: { executionMode: "direct" } },
    { provider: connection.provider, format: "claude", providerSpecificData: {} },
    { provider: "claude", format: "claude", providerSpecificData: { executionMode: "claude-code" } },
    { provider: "openai-compatible-custom", format: "openai", providerSpecificData: { executionMode: "claude-code" } },
  ])("keeps direct and other-provider model checks on their own transport (%j)", async (overrides) => {
    const direct = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      content: [{ type: "text", text: "hi" }],
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
    }));
    const result = await probeModelEndpoint({ baseUrl: "https://direct.test/v1", apiKey: "direct-key", model: "model", ...overrides });
    expect(result.ok).toBe(true);
    expect(direct).toHaveBeenCalledTimes(1);
    expect(mocks.createWorker).not.toHaveBeenCalled();
  });

  it("reports a native failure after the assistant stream instead of passing early", async () => {
    const worker = fakeWorker({ result: { type: "result", subtype: "error_during_execution", is_error: true, errors: ["model rejected this key"] } });
    const result = await probeConnectionModel(connection, "custom-model", { proxy: {} });
    expect(result).toMatchObject({ ok: false, status: 502, error: "model rejected this key" });
    expect(worker.close).toHaveBeenCalledTimes(1);
  });

  it("does not pass a successful runtime result without a completed model response", async () => {
    const worker = fakeWorker({ streamEvents: [] });
    const result = await probeConnectionModel(connection, "custom-model", { proxy: {} });
    expect(result).toMatchObject({ ok: false, status: 502, error: "Claude Code returned no completed model response" });
    expect(worker.close).toHaveBeenCalledTimes(1);
  });

  it("uses Anthropic response classification for an empty native response", async () => {
    const worker = fakeWorker({ streamEvents: events("custom-model", "", []) });
    const result = await probeConnectionModel(connection, "custom-model", { proxy: {} });
    expect(result).toMatchObject({ ok: false, status: 200, error: "Provider returned no content blocks for this model" });
    expect(worker.close).toHaveBeenCalledTimes(1);
  });

  it.each([{ connectionProxyEnabled: true }, { vercelRelayUrl: "https://relay.test" }])("rejects unsupported proxy settings without falling back (%j)", async (proxy) => {
    const direct = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Direct requests must not run"));
    const result = await probeConnectionModel(connection, "custom-model", { proxy });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(result.error).toContain("does not support connection proxy/relay");
    expect(mocks.createWorker).not.toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
  });
});

describe("one-shot Claude Code model check cleanup", () => {
  const input = { baseUrl: "https://custom.test/v1", apiKey: "upstream-key", model: "custom-model" };

  it("waits for worker cleanup before returning a verdict", async () => {
    const worker = fakeWorker();
    let finishClose;
    worker.close.mockImplementation(() => new Promise((resolve) => { finishClose = resolve; }));
    let returned = false;
    const probing = probeClaudeCodeModel(input).then((response) => { returned = true; return response; });
    await vi.waitFor(() => expect(worker.close).toHaveBeenCalledTimes(1));
    expect(returned).toBe(false);
    finishClose();
    expect((await (await probing).json()).content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("closes the worker on SDK failure", async () => {
    const worker = fakeWorker({ reply: false });
    const probing = probeClaudeCodeModel(input);
    await vi.waitFor(() => expect(worker.sendUserMessage).toHaveBeenCalled());
    mocks.createWorker.mock.calls[0][0].onFailure(new Error("SDK unavailable"));
    await expect(probing).rejects.toThrow("SDK unavailable");
    expect(worker.close).toHaveBeenCalledTimes(1);
  });

  it("rejects a model tool request and closes its worker", async () => {
    const worker = fakeWorker({ streamEvents: events("custom-model", "", [{ type: "tool_use", id: "tool_probe", name: "server-tool", input: {} }]) });
    await expect(probeClaudeCodeModel(input)).rejects.toMatchObject({ statusCode: 502, message: "Model check cannot execute tools" });
    expect(worker.close).toHaveBeenCalledTimes(1);
  });

  it("composes the deadline with a caller's otherwise unbounded signal", async () => {
    vi.useFakeTimers();
    const worker = fakeWorker({ reply: false });
    const caller = new AbortController();
    const probing = probeClaudeCodeModel({ ...input, signal: caller.signal, timeoutMs: 25 });
    const rejected = expect(probing).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(mocks.createWorker.mock.calls[0][0].signal.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an in-flight worker when a probe job is cancelled", async () => {
    const worker = fakeWorker({ reply: false });
    const caller = new AbortController();
    const probing = probeClaudeCodeModel({ ...input, signal: caller.signal });
    const rejected = expect(probing).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(worker.sendUserMessage).toHaveBeenCalled());
    caller.abort();
    await rejected;
    expect(mocks.createWorker.mock.calls[0][0].signal.aborted).toBe(true);
    expect(worker.close).toHaveBeenCalledTimes(1);
  });

  it("does not start a worker for an already cancelled model check", async () => {
    const caller = new AbortController();
    caller.abort();
    await expect(probeClaudeCodeModel({ ...input, signal: caller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.createWorker).not.toHaveBeenCalled();
  });

  it.each(["file:///tmp/model", "https://name:secret@custom.test/v1", "https://custom.test/v1?token=x"])("rejects invalid SDK upstream %s", async (baseUrl) => {
    await expect(probeClaudeCodeModel({ ...input, baseUrl })).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.createWorker).not.toHaveBeenCalled();
  });

  it("sends a real Claude Code request to a loopback upstream and closes the native worker", async () => {
    const requests = [];
    const server = createServer(async (request, response) => {
      if (request.method === "HEAD") { response.end(); return; }
      let raw = "";
      for await (const chunk of request) raw += chunk;
      if (request.url.includes("count_tokens")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ input_tokens: 8 }));
        return;
      }
      if (!request.url.startsWith("/v1/messages")) { response.writeHead(404); response.end(); return; }
      const body = JSON.parse(raw);
      requests.push({ headers: request.headers, body });
      response.setHeader("content-type", "text/event-stream");
      for (const event of events(body.model)) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const native = await vi.importActual("open-sse/shared/claudeCode/runtime.js");
    let worker;
    mocks.createWorker.mockImplementation(async (options) => {
      worker = await native.createClaudeCodeWorker(options);
      return worker;
    });
    try {
      const result = await probeConnectionModel({
        ...connection,
        providerSpecificData: { ...connection.providerSpecificData, baseUrl: `http://127.0.0.1:${server.address().port}/v1` },
      }, "claude-sonnet-4-6", { proxy: {} });
      expect(result.error).toBeNull();
      expect(result).toMatchObject({ ok: true, status: 200 });
      expect(requests).toHaveLength(1);
      expect(requests[0].body.model).toBe("claude-sonnet-4-6");
      expect(requests[0].body.max_tokens).toBe(1024);
      expect(requests[0].body.thinking).toEqual({ type: "disabled" });
      expect(requests[0].body.tools || []).toEqual([]);
      expect(requests[0].headers.authorization).toBe("Bearer selected-upstream-key");
      expect(requests[0].headers["anthropic-beta"]).toBeDefined();
      expect(requests[0].headers["x-9router-runtime-hop"]).toBe(claudeCodeRuntimeHop());
      expect(worker.closed).toBe(true);
    } finally {
      await worker?.close();
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    }
  }, 30000);
});
