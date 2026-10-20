import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeProbeStream, createStreamMetrics, ESSAY_PROMPT, PING_PROMPT } from "@/lib/modelProbe/streamMetrics.js";
import { probeModelEndpoint } from "@/lib/modelProbe/probe.js";

vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn(async () => ({})) }));

const encode = (event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`;
const token = (text) => ({ choices: [{ delta: { content: text } }] });
const finish = { choices: [{ delta: {}, finish_reason: "stop" }] };

// Advance the clock only when the next network chunk arrives, including delayed usage/EOF.
function streamFixture(chunks) {
  let time = 1000;
  let index = 0;
  const reader = {
    read: vi.fn(async () => {
      const chunk = chunks[index++];
      if (!chunk) return { done: true };
      time = chunk.at;
      if (chunk.error) throw chunk.error;
      return { done: false, value: typeof chunk.data === "string" ? new TextEncoder().encode(chunk.data) : chunk.data };
    }),
    cancel: vi.fn(async () => {}),
    releaseLock: vi.fn(),
  };
  return {
    now: () => time,
    response: { ok: true, status: 200, headers: new Headers({ "content-type": "text/event-stream" }), body: { getReader: () => reader } },
    reader,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("streaming model test metrics", () => {
  it("does not count parser time as generation time when the whole response arrives in one read", async () => {
    const fixture = streamFixture([{
      at: 1200,
      data: encode(token("A small ")) + encode(token("essay with ")) + encode(token("several deltas."))
        + encode(finish) + encode({ usage: { completion_tokens: 644 } }) + encode("[DONE]"),
    }]);
    let time = 1200;
    const now = vi.fn(() => time++);

    expect(await consumeProbeStream(fixture.response, { startTime: 1000, now })).toEqual({
      ok: true, error: null, ttftMs: 200, responseDurationMs: null,
      outputTokens: 644, tokensPerSecond: null, tokensEstimated: false,
      note: "Output arrived together; first-to-last-token timing and speed are unavailable.",
    });
    expect(now).toHaveBeenCalledOnce();
    expect(fixture.reader.read).toHaveBeenCalledOnce();
  });

  it("uses chunk arrival times for multiple output events and excludes later usage", async () => {
    const fixture = streamFixture([
      { at: 1100, data: encode(token("A ")) + encode(token("small ")) },
      { at: 1600, data: encode(token("essay ")) + encode(token("ends.")) + encode(finish) },
      { at: 2500, data: encode({ usage: { completion_tokens: 30 } }) + encode("[DONE]") },
    ]);
    const now = vi.fn().mockReturnValueOnce(1100).mockReturnValueOnce(1600).mockReturnValueOnce(2500);

    expect(await consumeProbeStream(fixture.response, { startTime: 1000, now })).toEqual({
      ok: true, error: null, ttftMs: 100, responseDurationMs: 500,
      outputTokens: 30, tokensPerSecond: 60, tokensEstimated: false,
    });
    expect(now).toHaveBeenCalledTimes(3);
  });

  it("timestamps a final event without a delimiter at its payload arrival, before delayed EOF", async () => {
    const fixture = streamFixture([
      { at: 1100, data: encode(token("An ")) },
      { at: 1500, data: encode({ choices: [{ delta: { content: "essay." }, finish_reason: "stop" }] }).trimEnd() },
    ]);
    const now = vi.fn().mockReturnValueOnce(1100).mockReturnValueOnce(1500).mockReturnValueOnce(4000);

    expect(await consumeProbeStream(fixture.response, { startTime: 1000, now })).toMatchObject({
      ok: true, ttftMs: 100, responseDurationMs: 400, outputTokens: 3, tokensPerSecond: 7.5,
    });
    expect(now).toHaveBeenCalledTimes(3);
  });

  it("measures output arrival and excludes role, finish, usage and stream teardown time", async () => {
    const fixture = streamFixture([
      { at: 1100, data: encode({ choices: [{ delta: { role: "assistant", content: "" } }] }) },
      { at: 1300, data: encode(token("Small ")) },
      { at: 1700, data: encode(token("essay.")) },
      { at: 2000, data: encode(finish) },
      { at: 2600, data: encode({ choices: [], usage: { completion_tokens: 20 } }) },
      { at: 3000, data: encode("[DONE]") },
    ]);
    expect(await consumeProbeStream(fixture.response, { startTime: 1000, now: fixture.now })).toEqual({
      ok: true, error: null, ttftMs: 300, responseDurationMs: 400,
      outputTokens: 20, tokensPerSecond: 50, tokensEstimated: false,
    });
    expect(fixture.reader.releaseLock).toHaveBeenCalledOnce();
  });

  it("parses UTF-8, CRLF and multiline SSE split across arbitrary chunks", async () => {
    const raw = new TextEncoder().encode(`: keepalive\r\n\r\nevent: message\r\ndata: {"choices": [\r\ndata: {"delta": {"content": "café"}}]}\r\n\r\n${encode(finish)}`);
    const fixture = streamFixture([...raw].map((byte, index) => ({ at: 1100 + index, data: Uint8Array.of(byte) })));
    const result = await consumeProbeStream(fixture.response, { startTime: 1000, now: fixture.now });
    expect(result).toMatchObject({
      ok: true, outputTokens: 1, tokensEstimated: true, responseDurationMs: null, tokensPerSecond: null,
      note: "Output arrived together; first-to-last-token timing and speed are unavailable.",
    });
    expect(result.ttftMs).toBeGreaterThan(100);
  });

  it("tracks Anthropic text/thinking output and final output usage", async () => {
    const fixture = streamFixture([
      { at: 1100, data: encode({ type: "message_start", message: { usage: { input_tokens: 20, output_tokens: 0 } } }) },
      { at: 1200, data: encode({ type: "content_block_start", content_block: { type: "thinking", thinking: "" } }) },
      { at: 1500, data: encode({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Think" } }) },
      { at: 1900, data: encode({ type: "content_block_delta", delta: { type: "text_delta", text: "Essay" } }) },
      { at: 2500, data: encode({ type: "message_delta", usage: { output_tokens: 40 }, delta: { stop_reason: "end_turn" } }) },
      { at: 2900, data: encode({ type: "message_stop" }) },
    ]);
    expect(await consumeProbeStream(fixture.response, { startTime: 1000, now: fixture.now })).toEqual({
      ok: true, error: null, ttftMs: 500, responseDurationMs: 400,
      outputTokens: 40, tokensPerSecond: 100, tokensEstimated: false,
    });
  });

  it.each(["[DONE]", { type: "message_stop" }])("stops at terminal event %j even if the gateway leaves the body open", async (terminal) => {
    const fixture = streamFixture([
      { at: 1200, data: encode(token("essay")) + encode(finish) },
      { at: 1600, data: encode({ usage: { completion_tokens: 12 } }) + encode(terminal) },
      { at: 1800, error: new Error("Must not wait for EOF after the terminal event") },
    ]);
    expect(await consumeProbeStream(fixture.response, { startTime: 1000, now: fixture.now })).toMatchObject({ ok: true, outputTokens: 12 });
    expect(fixture.reader.read).toHaveBeenCalledTimes(2);
    expect(fixture.reader.cancel).toHaveBeenCalled();
  });

  it("ignores the provisional message_start token count when Anthropic fails midstream", async () => {
    const fixture = streamFixture([
      { at: 1100, data: encode({ type: "message_start", message: { usage: { output_tokens: 1 } } }) },
      { at: 1200, data: encode({ type: "content_block_delta", delta: { type: "text_delta", text: "A partial essay." } }) },
      { at: 1500, data: encode({ type: "error", error: { message: "Overloaded" } }) },
    ]);
    expect(await consumeProbeStream(fixture.response, { startTime: 1000, now: fixture.now })).toMatchObject({
      ok: false, error: "Overloaded", outputTokens: 4, tokensEstimated: true, ttftMs: 200,
    });
  });

  it("marks estimated token rates when the provider omits usage", async () => {
    const fixture = streamFixture([
      { at: 1100, data: encode(token("abcd")) },
      { at: 1300, data: encode(token("efgh")) + encode("[DONE]") },
    ]);
    expect(await consumeProbeStream(fixture.response, { startTime: 1000, now: fixture.now })).toMatchObject({
      ok: true, outputTokens: 2, tokensEstimated: true, ttftMs: 100, responseDurationMs: 200, tokensPerSecond: 10,
    });
  });

  it("keeps partial statistics for a provider error event", async () => {
    const fixture = streamFixture([
      { at: 1100, data: encode(token("abcd")) },
      { at: 1500, data: encode(token("efgh")) },
      { at: 1900, data: encode({ error: { message: "Quota exhausted" } }) },
    ]);
    expect(await consumeProbeStream(fixture.response, { startTime: 1000, now: fixture.now })).toMatchObject({
      ok: false, error: "Quota exhausted", ttftMs: 100, responseDurationMs: 400, outputTokens: 2, tokensPerSecond: 5,
    });
  });

  it.each([
    { suffix: [], error: "Provider stream ended before the response completed" },
    { suffix: [{ at: 1800, error: new Error("Socket reset") }], error: "Socket reset" },
    { suffix: [{ at: 1800, data: "data: {broken}\n\n" }], error: "Provider returned an invalid streaming event" },
  ])("reports incomplete/malformed/network failures with observed tokens ($error)", async ({ suffix, error }) => {
    const fixture = streamFixture([{ at: 1200, data: encode(token("partial")) }, ...suffix]);
    expect(await consumeProbeStream(fixture.response, { startTime: 1000, now: fixture.now })).toMatchObject({
      ok: false, error, ttftMs: 200, responseDurationMs: 0, tokensPerSecond: null,
    });
  });

  it("handles an error before output without invented zero-valued timings", async () => {
    expect(await consumeProbeStream(Response.json({ error: { message: "Invalid API key" } }, { status: 401 }))).toMatchObject({
      ok: false, error: "HTTP 401: Invalid API key", ttftMs: null, responseDurationMs: null, tokensPerSecond: null, outputTokens: null,
    });
  });

  it("preserves a nonstreaming provider's usage without inventing timings", async () => {
    expect(await consumeProbeStream(Response.json({ choices: [{ message: { content: "An essay" } }], usage: { completion_tokens: 6 } }))).toMatchObject({
      ok: true, ttftMs: null, responseDurationMs: null, tokensPerSecond: null, outputTokens: 6, tokensEstimated: false,
      note: expect.stringContaining("non-streaming"),
    });
  });

  it("keeps partial measurements when the caller cancels a stream", async () => {
    const controller = new AbortController();
    let reads = 0;
    const fixture = streamFixture([{ at: 1200, data: encode(token("partial")) }]);
    const originalRead = fixture.reader.read;
    fixture.reader.read = async () => {
      if (++reads === 2) controller.abort(new DOMException("Test cancelled", "AbortError"));
      return originalRead();
    };
    expect(await consumeProbeStream(fixture.response, { startTime: 1000, now: fixture.now, signal: controller.signal })).toMatchObject({
      ok: false, error: "Test cancelled", ttftMs: 200, responseDurationMs: 0,
    });
  });

  it("does not pass streams containing only control events", () => {
    const metrics = createStreamMetrics({ startTime: 1000, now: () => 1200 });
    metrics.add({ choices: [{ delta: { role: "assistant" } }] });
    metrics.add(finish);
    expect(metrics.result()).toMatchObject({ ok: false, ttftMs: null, responseDurationMs: null, tokensPerSecond: null });
  });
});

describe("model endpoint test modes", () => {
  it.each(["openai", "claude"])("uses the exact essay prompt and a streaming request for %s", async (format) => {
    const response = new Response(encode(token("essay")) + encode(finish), { headers: { "content-type": "text/event-stream" } });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const result = await probeModelEndpoint({ baseUrl: "https://model.test/v1", apiKey: "selected-key", model: "test-model", format, testType: "essay", proxy: {} });
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toMatchObject({
      stream: true, messages: [{ role: "user", content: ESSAY_PROMPT }], max_tokens: 2048,
    });
    expect(result).toMatchObject({ ok: true, testType: "essay", outputTokens: 2, tokensEstimated: true });
  });

  it("uses a short ping/pong instruction for an explicit ping test", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [{ message: { content: "pong" } }] }));
    const result = await probeModelEndpoint({ baseUrl: "https://model.test/v1", model: "test-model", testType: "ping", proxy: {} });
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toMatchObject({ stream: false, messages: [{ role: "user", content: PING_PROMPT }] });
    expect(result).toMatchObject({ ok: true, testType: "ping", latencyMs: expect.any(Number) });
  });

  it("distinguishes an external deadline from caller cancellation", async () => {
    const controller = new AbortController();
    const timeout = new DOMException("External test deadline exceeded", "TimeoutError");
    controller.abort(timeout);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(timeout);
    const result = await probeModelEndpoint({ baseUrl: "https://model.test/v1", model: "test-model", testType: "essay", proxy: {}, signal: controller.signal });
    expect(result).toMatchObject({ ok: false, error: "Model test timed out", ttftMs: null, responseDurationMs: null });
  });
});
