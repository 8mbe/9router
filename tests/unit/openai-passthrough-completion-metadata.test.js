import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));
vi.mock("@/lib/usageDb.js", () => db);

import { FORMATS } from "../../open-sse/translator/formats.js";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";
import { buildOnStreamComplete } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { formatDoneLine } from "../../open-sse/handlers/chatCore/requestDetail.js";

const chunk = (delta = {}, finishReason = null) => ({
  id: "chatcmpl-test-metadata",
  choices: [{ index: 0, delta, finish_reason: finishReason }]
});
const sse = (data) => `data: ${JSON.stringify(data)}\n\n`;

async function runStream(input, sourceFormat = FORMATS.OPENAI) {
  const onStreamComplete = vi.fn();
  const stream = new ReadableStream({
    start(controller) {
      // Split bytes inside an SSE line to exercise the real buffering path.
      const bytes = new TextEncoder().encode(input);
      controller.enqueue(bytes.slice(0, 23));
      controller.enqueue(bytes.slice(23));
      controller.close();
    }
  }).pipeThrough(createPassthroughStreamWithLogger(
    "openai-compatible-chat-test", null, "moonshotai/kimi-k3", null,
    { messages: [{ role: "user", content: "Continue" }] }, onStreamComplete, null, sourceFormat
  ));
  const output = await new Response(stream).text();
  expect(onStreamComplete).toHaveBeenCalledTimes(1);
  return { output, metadata: onStreamComplete.mock.calls[0][3] };
}

beforeEach(() => vi.clearAllMocks());

describe("OpenAI passthrough completion evidence", () => {
  it("counts parallel tool calls once across split and repeated deltas", async () => {
    const input = [
      sse(chunk({ role: "assistant" })),
      sse(chunk({ tool_calls: [{ index: 0, function: { arguments: "{" } }] })),
      sse(chunk({ tool_calls: [
        { index: 0, id: "call_shell", function: { name: "shell", arguments: '\"command\":' } },
        { index: 1, id: "call_read", function: { name: "read", arguments: "{}" } }
      ] })),
      sse(chunk({ tool_calls: [{ index: 0, id: "call_shell", function: { name: null, arguments: '\"pwd\"}' } }] })),
      sse(chunk({}, "tool_calls")),
      "data: [DONE]\n\n"
    ].join("");
    const { output, metadata } = await runStream(input);
    expect(metadata).toEqual({ finishReason: "tool_calls", toolCallCount: 2, upstreamDoneSeen: true });
    expect(output).toContain('\"name\":null');
    expect(output).toContain('\"finish_reason\":\"tool_calls\"');
  });

  it("distinguishes a truncated EOF from an upstream terminal event", async () => {
    const { output, metadata } = await runStream(sse(chunk({
      tool_calls: [{ index: 0, id: "call_partial", function: { name: "shell", arguments: '{\"command\":\"' } }]
    })));
    expect(metadata).toEqual({ finishReason: null, toolCallCount: 1, upstreamDoneSeen: false });
    // Diagnostics preserve existing wire behavior: EOF still appends [DONE].
    expect(output).toContain("data: [DONE]");
    expect(output).not.toContain('\"finish_reason\":\"stop\"');
  });

  it.each(["stop", "length", "content_filter"])("records the observed %s finish without a closing newline", async (finishReason) => {
    const { output, metadata } = await runStream(`data: ${JSON.stringify(chunk({}, finishReason))}`);
    expect(metadata).toEqual({ finishReason, toolCallCount: 0, upstreamDoneSeen: false });
    expect(output).toContain(`\"finish_reason\":\"${finishReason}\"`);
  });

  it("records an upstream sentinel received without a closing newline", async () => {
    const { metadata } = await runStream(sse(chunk({}, "stop")) + "data: [DONE]");
    expect(metadata).toEqual({ finishReason: "stop", toolCallCount: 0, upstreamDoneSeen: true });
  });

  it("uses distinct ids when a compatible upstream omits tool indices", async () => {
    const { metadata } = await runStream([
      sse(chunk({ tool_calls: [{ id: "call_first", function: { name: "shell", arguments: "{}" } }] })),
      sse(chunk({ tool_calls: [{ id: "call_second", function: { name: "read", arguments: "{}" } }] })),
      sse(chunk({ tool_calls: [{ id: "call_first", function: { arguments: " " } }] })),
      sse(chunk({}, "tool_calls"))
    ].join(""));
    expect(metadata.toolCallCount).toBe(2);
  });

  it("preserves a provider's stop finish even when it emitted a tool call", async () => {
    const { output, metadata } = await runStream([
      sse(chunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "shell", arguments: "{}" } }] })),
      sse(chunk({}, "stop"))
    ].join(""));
    expect(metadata).toEqual({ finishReason: "stop", toolCallCount: 1, upstreamDoneSeen: false });
    expect(output).toContain('\"finish_reason\":\"stop\"');
    expect(output).not.toContain('\"finish_reason\":\"tool_calls\"');
  });

  it("keeps other passthrough formats outside these diagnostics", async () => {
    const { metadata } = await runStream(sse({ type: "message_stop" }), FORMATS.CLAUDE);
    expect(metadata).toBeUndefined();
  });
});

describe("stream completion diagnostics persistence", () => {
  it("saves terminal evidence and includes the observed finish and tool count in DONE", () => {
    const log = { line: vi.fn() };
    const { onStreamComplete } = buildOnStreamComplete({
      provider: "openai-compatible-chat-test", model: "moonshotai/kimi-k3",
      requestStartTime: Date.now() - 10, body: { messages: [] }, stream: true, log
    });
    onStreamComplete({ content: "", thinking: "Planning" }, { prompt_tokens: 96000, completion_tokens: 41 }, Date.now(), {
      finishReason: "stop", toolCallCount: 0, upstreamDoneSeen: true
    });
    expect(db.saveRequestDetail.mock.calls[0][0].response).toMatchObject({
      finish_reason: "stop", tool_call_count: 0, upstream_done_seen: true
    });
    expect(log.line.mock.calls[0][2]).toContain("FINISH:stop · TOOL_CALLS:0");
  });

  it("labels an unobserved finish as missing and preserves other DONE callers", () => {
    const base = { usage: { prompt_tokens: 96000, completion_tokens: 41 }, latency: { total: 500, ttft: 20 } };
    expect(formatDoneLine(base)).toBe("DONE 500ms · TTFT 20ms · IN 96000 · OUT 41");
    expect(formatDoneLine({ ...base, finishReason: null, toolCallCount: 1 }))
      .toBe("DONE 500ms · TTFT 20ms · IN 96000 · OUT 41 · FINISH:missing · TOOL_CALLS:1");
  });
});
