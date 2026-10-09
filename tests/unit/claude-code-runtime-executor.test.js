import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeRuntimeExecutor } from "../../open-sse/executors/claude-code-runtime.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { closeClaudeCodeSessions, getClaudeCodeContinuation } from "../../open-sse/shared/claudeCode/sessions.js";
import { CLAUDE_CODE } from "../../open-sse/config/claudeCodeConstants.js";

const servers = [];
const provider = "anthropic-compatible-executor-test";
const model = "claude-sonnet-4-6";
const tool = {
  name: "lookup",
  description: "Read a record in the caller's workspace",
  input_schema: {
    type: "object",
    properties: { value: { $ref: "#/$defs/value" } },
    $defs: { value: { type: "string", enum: ["same", "different"] } },
    required: ["value"], additionalProperties: false,
  },
};
const calls = [
  { type: "tool_use", id: "toolu_first", name: "mcp__client__lookup", input: { value: "same" } },
  { type: "tool_use", id: "toolu_second", name: "mcp__client__lookup", input: { value: "same" } },
];

function eventsFor(content, messageId = "msg_mock", responseModel = model) {
  const events = [{
    type: "message_start", message: {
      id: messageId, type: "message", role: "assistant", model: responseModel,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 25, output_tokens: 0 },
    },
  }];
  content.forEach((block, index) => {
    const isTool = block.type === "tool_use";
    events.push({ type: "content_block_start", index, content_block: isTool ? { ...block, input: {} } : { ...block, text: "" } });
    events.push({ type: "content_block_delta", index, delta: isTool
      ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
      : { type: "text_delta", text: block.text } });
    events.push({ type: "content_block_stop", index });
  });
  events.push({ type: "message_delta", delta: {
    stop_reason: content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null,
  }, usage: { output_tokens: 8 } });
  events.push({ type: "message_stop" });
  return events;
}

function messageFromSse(text) {
  const events = text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
  const message = structuredClone(events.find((event) => event.type === "message_start").message);
  const inputs = new Map();
  for (const event of events) {
    if (event.type === "content_block_start") message.content[event.index] = structuredClone(event.content_block);
    if (event.type === "content_block_delta") {
      if (event.delta.type === "text_delta") message.content[event.index].text += event.delta.text;
      else if (event.delta.type === "input_json_delta") inputs.set(event.index, (inputs.get(event.index) || "") + event.delta.partial_json);
    }
    if (event.type === "message_delta") Object.assign(message, event.delta);
  }
  for (const [index, input] of inputs) message.content[index].input = JSON.parse(input);
  expect(events.at(-1).type).toBe("message_stop");
  return message;
}

async function mockUpstream(responses) {
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.method === "HEAD") { res.end(); return; }
    let data = "";
    for await (const chunk of req) data += chunk;
    if (req.url.includes("count_tokens")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ input_tokens: 25 }));
      return;
    }
    if (!req.url.startsWith("/v1/messages")) { res.writeHead(404); res.end(); return; }
    const body = JSON.parse(data);
    requests.push({ body, headers: req.headers });
    const content = responses[requests.length - 1];
    if (!content) { res.writeHead(500); res.end("Unexpected model request"); return; }
    res.setHeader("content-type", "text/event-stream");
    for (const event of eventsFor(content, `msg_mock_${requests.length}`, body.model)) {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

function options(baseUrl = "http://127.0.0.1:12345/v1", overrides = {}) {
  const credentials = {
    apiKey: "mock-upstream-only-key", connectionId: "account-a",
    runtimeOwnerId: "api-key:owner-a", runtimeConversationId: "harness-conversation-a",
    clientMode: "harness", runtimeRequestUrl: "http://router.test/v1/messages",
    rawHeaders: { "x-9router-client-mode": "harness", "x-9router-session-id": "harness-conversation-a" },
    providerSpecificData: { baseUrl, executionMode: "claude-code" },
    ...overrides.credentials,
  };
  return {
    model, stream: false,
    body: { model, system: "Use the caller's tools.", max_tokens: 128, tools: [structuredClone(tool)], messages: [{ role: "user", content: "Look up the same record twice." }] },
    ...overrides, credentials,
  };
}

function continuation(first, firstMessage, content) {
  return {
    ...first,
    body: {
      ...first.body,
      messages: [...first.body.messages, { role: "assistant", content: firstMessage.content }, { role: "user", content }],
    },
  };
}

const results = () => [
  { type: "tool_result", tool_use_id: "toolu_second", content: "second-client-error", is_error: true },
  { type: "tool_result", tool_use_id: "toolu_first", content: "first-client-result" },
];

async function fakeWaitingSession({ toolCalls = calls, tools = [tool], system } = {}) {
  const createWorker = vi.fn(async ({ onEvent, waitForToolResult }) => ({
    sendUserMessage: vi.fn(() => queueMicrotask(() => {
      for (const event of eventsFor(toolCalls)) onEvent(event);
      Promise.all(toolCalls.map((call) => waitForToolResult(call.id)))
        .then(() => {
          for (const event of eventsFor([{ type: "text", text: "Caller results applied." }], "msg_repaired")) onEvent(event);
        }).catch(() => {});
    })),
    close: vi.fn(async () => {}),
  }));
  const executor = new ClaudeCodeRuntimeExecutor(provider, createWorker);
  const first = options();
  first.body.tools = structuredClone(tools);
  if (system !== undefined) first.body.system = structuredClone(system);
  const response = await executor.execute(first);
  const message = await response.response.json();
  return { executor, createWorker, first, message, next: continuation(first, message, results()) };
}

afterEach(async () => {
  await closeClaudeCodeSessions();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => {
    server.close(resolve); server.closeAllConnections();
  })));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Claude Code executor through the native binary and local Anthropic API", () => {
  it("returns client tool calls, resumes exact reversed results, replays safely, and accepts a later user turn", async () => {
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "ambient-token-must-not-leak");
    vi.stubEnv("CLAUDECODE", "1");
    const upstream = await mockUpstream([
      calls,
      [{ type: "text", text: "Both caller results received." }],
      [{ type: "text", text: "Follow-up received in the same session." }],
    ]);
    const executor = new ClaudeCodeRuntimeExecutor(provider);
    const first = options(upstream.url, { stream: true });
    const firstResult = await executor.execute(first);
    expect(firstResult.responseFormat).toBe("claude");
    const sessionId = firstResult.response.headers.get("x-9router-session-id");
    expect(sessionId).toBe("harness-conversation-a");
    const firstMessage = messageFromSse(await firstResult.response.text());
    expect(firstMessage.stop_reason).toBe("tool_use");
    expect(firstMessage.content).toEqual(calls.map((call) => ({ ...call, name: "lookup" })));
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0].body.tools).toHaveLength(1);
    expect(upstream.requests[0].body.tools[0].name).toBe("mcp__client__lookup");
    expect(upstream.requests[0].body.tools[0].input_schema).toEqual(tool.input_schema);
    expect(upstream.requests[0].body.max_tokens).toBe(128);
    expect(upstream.requests[0].body.thinking).toEqual({ type: "disabled" });
    expect(upstream.requests[0].headers["x-api-key"]).toBe("mock-upstream-only-key");
    expect(upstream.requests[0].headers.authorization).toBeUndefined();

    const next = { ...continuation(first, firstMessage, results()), stream: false };
    expect(getClaudeCodeContinuation(next.body, {
      ownerId: next.credentials.runtimeOwnerId, provider, conversationId: sessionId,
    })).toEqual({ connectionId: "account-a", sessionId });
    const secondResult = await executor.execute(next);
    const secondMessage = await secondResult.response.json();
    expect(secondResult.response.headers.get("x-9router-session-id")).toBe(sessionId);
    expect(secondResult.response.headers.get("content-type")).toBe("application/json");
    expect(secondMessage.content).toEqual([{ type: "text", text: "Both caller results received." }]);
    expect(secondMessage.stop_reason).toBe("end_turn");
    expect(upstream.requests).toHaveLength(2);
    const sentResults = upstream.requests[1].body.messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .filter((block) => block.type === "tool_result");
    expect(sentResults.map((result) => result.tool_use_id)).toEqual(["toolu_first", "toolu_second"]);
    expect(JSON.stringify(sentResults[0].content)).toContain("first-client-result");
    expect(JSON.stringify(sentResults[1].content)).toContain("second-client-error");
    expect(sentResults[1].is_error).toBe(true);
    expect(await (await executor.execute(next)).response.json()).toEqual(secondMessage);
    expect(upstream.requests).toHaveLength(2);

    const third = {
      ...next,
      body: { ...next.body, messages: [...next.body.messages, { role: "assistant", content: secondMessage.content }, { role: "user", content: "Continue this conversation." }] },
    };
    const thirdResult = await executor.execute(third);
    expect(thirdResult.response.headers.get("x-9router-session-id")).toBe(sessionId);
    expect((await thirdResult.response.json()).content).toEqual([{ type: "text", text: "Follow-up received in the same session." }]);
    expect(upstream.requests).toHaveLength(3);
    expect(JSON.stringify(upstream.requests[2].body.messages)).toContain("first-client-result");
    expect(JSON.stringify(upstream.requests[2].body.messages)).toContain("Continue this conversation.");
  }, 30000);
});

describe("Claude Code executor routing and continuation guards", () => {
  it.each([
    { clientTool: "claude" },
    { credentials: { rawHeaders: { "user-agent": "claude-cli/2.0.0", "x-9router-client-mode": "harness" } } },
    { credentials: { clientMode: "claude-code" } },
    { credentials: { clientMode: "direct" } },
  ])("delegates native Claude or explicit direct requests without creating a worker (%j)", async (override) => {
    const directResult = { response: Response.json({ direct: true }) };
    const direct = vi.spyOn(DefaultExecutor.prototype, "execute").mockResolvedValue(directResult);
    const createWorker = vi.fn(() => { throw new Error("A native client must never start server Claude Code"); });
    const executor = new ClaudeCodeRuntimeExecutor(provider, createWorker);
    const input = options(undefined, override);
    expect(await executor.execute(input)).toBe(directResult);
    expect(direct).toHaveBeenCalledWith(input);
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("rejects another owner's tool results without creating a replacement worker", async () => {
    const { executor, createWorker, next } = await fakeWaitingSession();
    next.credentials = { ...next.credentials, runtimeOwnerId: "api-key:owner-b" };
    await expect(executor.execute(next)).rejects.toMatchObject({ statusCode: 409 });
    expect(createWorker).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["model", (next) => { next.model = "claude-haiku-4-5"; }],
    ["schema", (next) => { next.body.tools = [{ ...tool, input_schema: { type: "object", properties: { other: { type: "number" } } } }]; }],
    ["system", (next) => { next.body.system = "Changed system prompt"; }],
    ["account", (next) => { next.credentials = { ...next.credentials, connectionId: "account-b" }; }],
    ["history", (next) => { next.body.messages[0] = { role: "user", content: "Changed original message" }; }],
    ["unknown result ID", (next) => { next.body.messages.at(-1).content[0].tool_use_id = "foreign-id"; }],
    ["duplicate result IDs", (next) => { next.body.messages.at(-1).content[0].tool_use_id = "toolu_first"; }],
    ["missing result", (next) => { next.body.messages.at(-1).content.pop(); }],
    ["extra user content with results", (next) => { next.body.messages.at(-1).content.push({ type: "text", text: "Extra instruction" }); }],
  ])("rejects changed %s before continuing the suspended worker", async (_label, mutate) => {
    const { executor, createWorker, next } = await fakeWaitingSession();
    mutate(next);
    await expect(executor.execute(next)).rejects.toMatchObject({ statusCode: 409 });
    expect(createWorker).toHaveBeenCalledTimes(1);
  });

  it("replays the initial response without starting another worker or generation", async () => {
    const { executor, createWorker, first, message } = await fakeWaitingSession();
    expect(await (await executor.execute(first)).response.json()).toEqual(message);
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect((await createWorker.mock.results[0].value).sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("treats a schema property named cache_control as caller data when checking configuration", async () => {
    const callerTool = structuredClone(tool);
    callerTool.input_schema.properties.cache_control = { type: "string" };
    const { executor, createWorker, next } = await fakeWaitingSession({ tools: [callerTool] });
    next.body.tools = structuredClone(next.body.tools);
    next.body.tools[0].input_schema.properties.cache_control = { type: "integer" };
    await expect(executor.execute(next)).rejects.toMatchObject({ statusCode: 409 });
    expect(createWorker).toHaveBeenCalledTimes(1);
  });

  it("rejects edits to a caller tool argument named cache_control in the returned history", async () => {
    const toolCalls = calls.map((call) => ({ ...call, input: { ...call.input, cache_control: "caller-value" } }));
    const { executor, createWorker, next } = await fakeWaitingSession({ toolCalls });
    next.body.messages[1].content[0].input.cache_control = "edited-caller-value";
    await expect(executor.execute(next)).rejects.toMatchObject({ statusCode: 409 });
    expect(createWorker).toHaveBeenCalledTimes(1);
  });

  it("permits changed Anthropic cache hints while preserving the suspended invocation", async () => {
    const { executor, next } = await fakeWaitingSession({ system: [{ type: "text", text: "Use the caller's tools.", cache_control: { type: "ephemeral", ttl: "5m" } }] });
    next.body.tools = next.body.tools.map((definition) => ({ ...definition, cache_control: { type: "ephemeral", ttl: "1h" } }));
    next.body.system = [{ type: "text", text: "Use the caller's tools.", cache_control: { type: "ephemeral", ttl: "1h" } }];
    next.body.messages[0] = { role: "user", content: [{ type: "text", text: "Look up the same record twice.", cache_control: { type: "ephemeral" } }] };
    next.body.messages[1].content[0].cache_control = { type: "ephemeral", ttl: "1h" };
    next.body.messages.at(-1).content[0].content = [{ type: "text", text: "second-client-error", cache_control: { type: "ephemeral" } }];
    const response = await executor.execute(next);
    expect((await response.response.json()).content).toEqual([{ type: "text", text: "Caller results applied." }]);
  });

  it("keeps a rejected unsupported tool result pending so a corrected POST can resume", async () => {
    const { executor, createWorker, first, message, next } = await fakeWaitingSession();
    next.body.messages.at(-1).content[0].content = [{
      type: "document", source: { type: "text", media_type: "text/plain", data: "unsupported block" },
    }];
    await expect(executor.execute(next)).rejects.toMatchObject({ statusCode: 400 });
    const repaired = continuation(first, message, results());
    expect(getClaudeCodeContinuation(repaired.body, {
      ownerId: repaired.credentials.runtimeOwnerId, provider, conversationId: repaired.credentials.runtimeConversationId,
    })).toEqual({ connectionId: "account-a", sessionId: "harness-conversation-a" });
    const response = await executor.execute(repaired);
    expect((await response.response.json()).content).toEqual([{ type: "text", text: "Caller results applied." }]);
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect((await createWorker.mock.results[0].value).close).not.toHaveBeenCalled();
  });

  it("rejects an oversized initial history before creating a worker", async () => {
    const createWorker = vi.fn();
    const executor = new ClaudeCodeRuntimeExecutor(provider, createWorker);
    const first = options();
    first.body.messages[0].content = "😀".repeat(CLAUDE_CODE.maxHistoryBytes / 4);
    await expect(executor.execute(first)).rejects.toMatchObject({ statusCode: 413 });
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("blocks a self-referencing upstream before worker creation", async () => {
    const createWorker = vi.fn();
    const executor = new ClaudeCodeRuntimeExecutor(provider, createWorker);
    const input = options("http://router.test/v1");
    await expect(executor.execute(input)).rejects.toThrow("must not point back");
    expect(createWorker).not.toHaveBeenCalled();
  });
});
