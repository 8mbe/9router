import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaudeCodeWorker, normalizeClaudeCodeBaseUrl } from "../../open-sse/shared/claudeCode/runtime.js";
import { clientToolResultToMcp } from "../../open-sse/shared/claudeCode/clientTools.js";

const workers = [];
const servers = [];
const tool = {
  name: "lookup",
  description: "Look up a caller-owned record",
  input_schema: {
    type: "object",
    properties: { value: { $ref: "#/$defs/value" } },
    $defs: { value: { type: "string", enum: ["same", "different"] } },
    required: ["value"],
    additionalProperties: false,
  },
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
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
    const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    send({
      type: "message_start",
      message: {
        id: `msg_mock_${requests.length}`, type: "message", role: "assistant",
        model: body.model, content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 25, output_tokens: 0 },
      },
    });
    content.forEach((block, index) => {
      const isTool = block.type === "tool_use";
      send({ type: "content_block_start", index, content_block: isTool ? { ...block, input: {} } : { ...block, text: "" } });
      send({ type: "content_block_delta", index, delta: isTool
        ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
        : { type: "text_delta", text: block.text } });
      send({ type: "content_block_stop", index });
    });
    send({
      type: "message_delta",
      delta: { stop_reason: content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 8 },
    });
    send({ type: "message_stop" });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

async function startWorker(url, overrides = {}) {
  const worker = await createClaudeCodeWorker({
    model: "claude-sonnet-4-6", system: "Use the caller's tools.", tools: [tool],
    upstreamBaseUrl: url, apiKey: "mock-client-api-key", ...overrides,
  });
  workers.push(worker);
  return worker;
}

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  })));
  vi.unstubAllEnvs();
});

describe("Claude Code native worker with caller-owned tools", () => {
  it.each([
    ["https://upstream.test", "https://upstream.test"],
    ["https://upstream.test/v1/", "https://upstream.test"],
    ["https://upstream.test/v1/messages", "https://upstream.test"],
    ["https://upstream.test/proxy/v1/messages/", "https://upstream.test/proxy"],
    ["https://upstream.test/proxy/messages", "https://upstream.test/proxy"],
    ["https://upstream.test/v1/proxy", "https://upstream.test/v1/proxy"],
  ])("normalizes SDK endpoint %s to %s", (source, expected) => {
    expect(normalizeClaudeCodeBaseUrl(source)).toBe(expected);
  });

  it("uses stored /v1 connections, bearer authentication and the caller's small output limit with thinking disabled", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "ambient-key-must-not-be-forwarded");
    const upstream = await mockUpstream([[{ type: "text", text: "A short answer." }]]);
    const finished = deferred();
    const failures = [];
    const worker = await startWorker(`${upstream.url}/v1`, {
      maxTokens: 128,
      authMode: "bearer",
      apiKey: "fake-upstream-bearer-key",
      runtimeHop: "worker-smoke-hop",
      onMessage: (message) => { if (message.type === "result") finished.resolve(message); },
      onFailure: (error) => { failures.push(error); finished.reject(error); },
    });
    worker.sendUserMessage("Give a short answer.");
    await finished.promise;
    expect(failures).toEqual([]);
    expect(upstream.requests).toHaveLength(1);
    const request = upstream.requests[0];
    expect(request.body.max_tokens).toBe(128);
    expect(request.body.thinking).toEqual({ type: "disabled" });
    expect(request.headers.authorization).toBe("Bearer fake-upstream-bearer-key");
    expect(request.headers["x-api-key"]).toBeUndefined();
    expect(request.headers["anthropic-version"]).toBe("2023-06-01");
    expect(request.headers["anthropic-beta"]).toBeDefined();
    expect(request.headers["x-9router-runtime-hop"]).toBe("worker-smoke-hop");
  }, 30000);

  it("preserves raw schema and exact IDs for identical batched calls, errors, and follow-up turns", async () => {
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "ambient-token-must-not-be-forwarded");
    vi.stubEnv("CLAUDECODE", "1");
    const upstream = await mockUpstream([
      [
        { type: "tool_use", id: "toolu_first", name: "mcp__client__lookup", input: { value: "same" } },
        { type: "tool_use", id: "toolu_second", name: "mcp__client__lookup", input: { value: "same" } },
      ],
      [{ type: "text", text: "Both caller results received." }],
      [{ type: "text", text: "Follow-up received in the same session." }],
    ]);
    const firstResult = deferred();
    const secondResult = deferred();
    const batchComplete = deferred();
    const finalResults = [];
    const events = [];
    const failures = [];
    const calls = [];
    let stopReason;
    const worker = await startWorker(upstream.url, {
      waitForToolResult: (id, call) => {
        calls.push({ id, name: call.name, input: call.input });
        return id === "toolu_first" ? firstResult.promise : secondResult.promise;
      },
      onEvent: (event) => {
        events.push(event);
        if (event.type === "message_delta") stopReason = event.delta.stop_reason;
        if (event.type === "message_stop" && stopReason === "tool_use") batchComplete.resolve();
      },
      onMessage: (message) => { if (message.type === "result") finalResults.push(message); },
      onFailure: (error) => failures.push(error),
    });
    worker.sendUserMessage("Look up the same record twice.");
    await worker.ready;
    await batchComplete.promise;
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0].body.tools).toHaveLength(1);
    expect(upstream.requests[0].body.tools[0].input_schema).toEqual(tool.input_schema);
    expect(upstream.requests[0].headers["x-api-key"]).toBe("mock-client-api-key");
    expect(upstream.requests[0].headers.authorization).toBeUndefined();
    expect(calls).toEqual([{ id: "toolu_first", name: "lookup", input: { value: "same" } }]);

    // The caller may finish the second call first; server relay execution stays
    // sequential and binds every result to the SDK's exact PreToolUse ID.
    secondResult.resolve({ type: "tool_result", tool_use_id: "toolu_second", content: "second-client-error", is_error: true });
    firstResult.resolve({ type: "tool_result", tool_use_id: "toolu_first", content: "first-client-result" });
    await vi.waitFor(() => expect(finalResults).toHaveLength(1), { timeout: 20000 });
    expect(failures).toEqual([]);
    expect(calls.map((call) => call.id)).toEqual(["toolu_first", "toolu_second"]);
    const results = upstream.requests[1].body.messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .filter((block) => block.type === "tool_result");
    expect(results.map((result) => result.tool_use_id)).toEqual(["toolu_first", "toolu_second"]);
    expect(JSON.stringify(results[0].content)).toContain("first-client-result");
    expect(JSON.stringify(results[1].content)).toContain("second-client-error");
    expect(results[1].is_error).toBe(true);
    expect(events.filter((event) => event.type === "message_start")).toHaveLength(2);
    const sessionId = worker.sessionId;
    worker.sendUserMessage("Continue this conversation.");
    await vi.waitFor(() => expect(finalResults).toHaveLength(2), { timeout: 20000 });
    expect(worker.sessionId).toBe(sessionId);
    expect(upstream.requests).toHaveLength(3);
    expect(JSON.stringify(upstream.requests[2].body.messages)).toContain("first-client-result");
    expect(JSON.stringify(upstream.requests[2].body.messages)).toContain("Continue this conversation.");
  }, 30000);

  it.each(["close", "signal"])("cancels a pending client result through %s without another model call", async (cancelMode) => {
    const upstream = await mockUpstream([
      [{ type: "tool_use", id: "toolu_waiting", name: "mcp__client__lookup", input: { value: "same" } }],
    ]);
    const waiting = deferred();
    const aborted = deferred();
    const controller = new AbortController();
    const worker = await startWorker(upstream.url, {
      signal: controller.signal,
      waitForToolResult: (id, { signal }) => {
        waiting.resolve(id);
        return new Promise((resolve, reject) => {
          const abort = () => { aborted.resolve(); reject(signal.reason || new Error("aborted")); };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      },
    });
    worker.sendUserMessage("Look up a record.");
    expect(await waiting.promise).toBe("toolu_waiting");
    if (cancelMode === "signal") controller.abort();
    await worker.close();
    await aborted.promise;
    expect(worker.closed).toBe(true);
    expect(upstream.requests).toHaveLength(1);
    expect(() => worker.sendUserMessage("late")).toThrow("closed");
  }, 30000);

  it("fails closed on a mismatched client result ID and permits failure callbacks to close the worker", async () => {
    const upstream = await mockUpstream([
      [{ type: "tool_use", id: "toolu_expected", name: "mcp__client__lookup", input: { value: "same" } }],
    ]);
    const failure = deferred();
    let worker;
    worker = await startWorker(upstream.url, {
      waitForToolResult: async () => ({ type: "tool_result", tool_use_id: "toolu_wrong", content: "wrong" }),
      onFailure: async (error) => { failure.resolve(error); await worker.close(); },
    });
    worker.sendUserMessage("Look up a record.");
    expect((await failure.promise).message).toContain("ID does not match");
    await worker.close();
    expect(upstream.requests).toHaveLength(1);
  }, 30000);

  it("converts images and rejects unsupported result blocks without inventing text", () => {
    expect(clientToolResultToMcp({ type: "tool_result", tool_use_id: "toolu_image", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "YWJj" } },
    ] })).toEqual({ content: [{ type: "image", mimeType: "image/png", data: "YWJj" }], isError: false });
    expect(() => clientToolResultToMcp({ type: "tool_result", content: [
      { type: "image", source: { type: "url", url: "https://example.com/image.png" } },
    ] })).toThrow("text and base64 image");
  });
});
