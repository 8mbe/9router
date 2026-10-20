export const PING_PROMPT = "Ping. Reply with pong.";
export const ESSAY_PROMPT = "write a small essay";
export const ESSAY_TIMEOUT_MS = 120000;

function errorMessage(value, fallback = "Provider returned an error") {
  const message = typeof value === "string" ? value : value?.message || (value ? JSON.stringify(value) : "");
  return message.trim().slice(0, 500) || fallback;
}

function providerError(event) {
  if (event?.error) return errorMessage(event.error);
  if (event?.type === "error") return errorMessage(event.message);
  if (event?.status != null && !["0", "200"].includes(String(event.status)) && (event.msg || event.message)) {
    return `Provider status ${event.status}: ${errorMessage(event.msg || event.message)}`;
  }
  return null;
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => typeof part?.text === "string" ? part.text : "").join("");
  return "";
}

/** Counts only generated output events; metadata and terminal events never move the clock. */
export function createStreamMetrics({ startTime = Date.now(), now = Date.now } = {}) {
  let firstTokenTime = null;
  let lastTokenTime = null;
  let output = "";
  let reportedTokens = null;
  let completed = false;
  let terminal = false;
  let error = null;

  function addText(text) {
    if (!text) return;
    const time = now();
    if (firstTokenTime === null) firstTokenTime = time;
    lastTokenTime = time;
    output += text;
  }

  function add(event) {
    if (terminal) return;
    if (event === "[DONE]") { completed = true; terminal = true; return; }
    if (!event || typeof event !== "object") return;
    error ||= providerError(event);
    if (error) terminal = true;
    // message_start carries a provisional count, often 1, before any deltas arrive.
    const usage = event.type === "message_start" ? null : event.usage || event.response?.usage;
    const tokens = usage?.completion_tokens ?? usage?.output_tokens;
    if (typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0) reportedTokens = tokens;

    // The benchmark requests one completion. Ignore alternative choices if an upstream sends them.
    const choice = event.choices?.[0];
    if (choice) {
      const delta = choice.delta;
      if (delta) {
        addText(textContent(delta.content));
        addText(textContent(delta.reasoning_content || delta.reasoning || delta.thinking || delta.thinking_content));
      } else if (typeof choice.text === "string") addText(choice.text);
      if (choice.finish_reason != null) completed = true;
    }
    if (event.type === "content_block_start") {
      addText(textContent(event.content_block?.text || event.content_block?.thinking));
    } else if (event.type === "content_block_delta") {
      addText(textContent(event.delta?.text || event.delta?.thinking));
    } else if (event.type === "response.output_text.delta" || event.type === "response.reasoning_text.delta") {
      addText(textContent(event.delta));
    }
    if (event.type === "message_stop" || event.type === "response.completed") { completed = true; terminal = true; }
    if (event.type === "response.failed" || event.type === "response.incomplete") {
      error ||= errorMessage(event.response?.error || event.response?.incomplete_details, "Provider did not complete the response");
      terminal = true;
    }
  }

  function snapshot() {
    // Anthropic starts with output_tokens:0. That provisional value is not a count
    // of a partial response when the stream fails before its final usage event.
    const measuredTokens = reportedTokens === 0 && output ? null : reportedTokens;
    const outputTokens = measuredTokens ?? (output ? Math.max(1, Math.ceil(output.length / 4)) : null);
    const responseDurationMs = firstTokenTime === null ? null : Math.max(0, lastTokenTime - firstTokenTime);
    return {
      ttftMs: firstTokenTime === null ? null : Math.max(0, firstTokenTime - startTime),
      responseDurationMs,
      tokensPerSecond: responseDurationMs > 0 && outputTokens !== null ? outputTokens * 1000 / responseDurationMs : null,
      outputTokens,
      tokensEstimated: measuredTokens === null && outputTokens !== null,
    };
  }

  function result(failure = null) {
    const message = failure || error || (firstTokenTime === null
      ? "Provider returned no output tokens for this model"
      : !completed ? "Provider stream ended before the response completed" : null);
    return { ok: !message, error: message, ...snapshot() };
  }

  return { add, snapshot, result, isTerminal: () => terminal };
}

/** Read SSE incrementally, including events and UTF-8 characters split across network chunks. */
export async function consumeProbeStream(response, { startTime = Date.now(), now = Date.now, signal } = {}) {
  const metrics = createStreamMetrics({ startTime, now });
  const contentType = response.headers?.get?.("content-type") || "";
  if (!response.ok || contentType.includes("application/json")) {
    try {
      const raw = await response.text();
      let parsed;
      try { parsed = JSON.parse(raw); } catch { /* Keep the upstream's plain-text error. */ }
      const error = providerError(parsed);
      if (!response.ok) return metrics.result(`HTTP ${response.status}${raw ? `: ${error || errorMessage(raw)}` : ""}`);
      if (error) return metrics.result(error);
      // Some compatible gateways silently ignore stream:true. Do not fabricate token timings.
      const content = textContent(parsed?.choices?.[0]?.message?.content) || textContent(parsed?.content);
      if (!content) return metrics.result("Provider returned no output tokens for this model");
      const tokens = parsed?.usage?.completion_tokens ?? parsed?.usage?.output_tokens;
      const hasUsage = typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0;
      return {
        ok: true, error: null, ...metrics.snapshot(),
        outputTokens: hasUsage ? tokens : Math.max(1, Math.ceil(content.length / 4)),
        tokensEstimated: !hasUsage,
        note: "Provider returned a non-streaming response; token timings are unavailable",
      };
    } catch (error) { return metrics.result(errorMessage(error, "Could not read the provider response")); }
  }
  if (!response.body?.getReader) return metrics.result("Provider returned no response stream");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let invalidEvent = false;
  const aborted = () => reader.cancel(signal.reason).catch(() => {});
  signal?.addEventListener("abort", aborted, { once: true });

  function dispatch(raw) {
    const data = raw.split(/\r\n|\n|\r/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data.trim()) return;
    if (data.trim() === "[DONE]") { metrics.add("[DONE]"); return; }
    try { metrics.add(JSON.parse(data)); } catch { invalidEvent = true; }
  }

  function drain() {
    let boundary;
    while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
      dispatch(buffer.slice(0, boundary.index));
      buffer = buffer.slice(boundary.index + boundary[0].length);
    }
  }

  try {
    if (signal?.aborted) throw signal.reason || new DOMException("Model test cancelled", "AbortError");
    for (;;) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw signal.reason || new DOMException("Model test cancelled", "AbortError");
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      drain();
      // Usage can follow finish_reason, but [DONE]/message_stop close the protocol.
      // Some gateways leave the HTTP body open after this terminal event.
      if (metrics.isTerminal()) break;
    }
    buffer += decoder.decode();
    drain();
    if (buffer.trim()) dispatch(buffer);
    return metrics.result(invalidEvent ? "Provider returned an invalid streaming event" : null);
  } catch (error) {
    const cause = error?.cause;
    const detail = [cause?.code, cause?.message].filter(Boolean).join(": ");
    return metrics.result(`${errorMessage(error, "Provider stream failed")}${detail ? ` (${detail})` : ""}`);
  } finally {
    signal?.removeEventListener("abort", aborted);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
