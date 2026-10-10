import { ClaudeMessageAccumulator } from "open-sse/shared/claudeCode/anthropicWire.js";
import { ClaudeCodeBridgeError } from "open-sse/shared/claudeCode/policy.js";
import { claudeCodeRuntimeHop } from "open-sse/shared/claudeCode/loopGuard.js";
import { createClaudeCodeWorker } from "open-sse/shared/claudeCode/runtime.js";
import { CLAUDE_BLOCK } from "open-sse/translator/schema/index.js";

const DEFAULT_TIMEOUT_MS = 20000;

/** One isolated native turn with this key; model checks never borrow router sessions. */
export async function probeClaudeCodeModel({
  baseUrl, apiKey, model, authMode = "api-key", proxy, signal,
  maxTokens = 1024, timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (proxy?.connectionProxyEnabled || proxy?.vercelRelayUrl) {
    throw new ClaudeCodeBridgeError("Server Claude Code does not support connection proxy/relay settings yet; use direct execution");
  }
  let upstream;
  try { upstream = new URL(baseUrl); } catch { throw new ClaudeCodeBridgeError("Invalid custom Anthropic upstream URL"); }
  if (!["https:", "http:"].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw new ClaudeCodeBridgeError("Invalid custom Anthropic upstream URL");
  }
  if (!apiKey) throw new ClaudeCodeBridgeError("Configure an upstream API key for server Claude Code");

  const controller = new AbortController();
  const accumulator = new ClaudeMessageAccumulator();
  let messageStopped = false;
  let resolve;
  let reject;
  const completed = new Promise((yes, no) => { resolve = yes; reject = no; });
  // An abort may arrive while the SDK is still being imported or initialized.
  completed.catch(() => {});
  const abort = () => {
    const reason = signal?.reason || new DOMException("Claude Code model probe aborted", "AbortError");
    controller.abort(reason);
    reject(reason);
  };
  const timer = setTimeout(() => {
    const reason = new DOMException(`Timed out after ${timeoutMs}ms`, "TimeoutError");
    controller.abort(reason);
    reject(reason);
  }, timeoutMs);
  timer.unref?.();
  signal?.addEventListener("abort", abort, { once: true });
  let worker;

  try {
    if (signal?.aborted) abort();
    if (controller.signal.aborted) throw controller.signal.reason;
    worker = await createClaudeCodeWorker({
      model, system: "Reply briefly to the user's greeting.", tools: [],
      upstreamBaseUrl: baseUrl, apiKey, authMode, maxTokens,
      runtimeHop: claudeCodeRuntimeHop(), signal: controller.signal,
      waitForToolResult: async () => { throw new ClaudeCodeBridgeError("Model check cannot execute tools", 502); },
      onFailure: reject,
      onEvent: (event) => {
        try {
          if (event.type === "content_block_start" && event.content_block?.type === CLAUDE_BLOCK.TOOL_USE) {
            throw new ClaudeCodeBridgeError("Model check cannot execute tools", 502);
          }
          accumulator.add(event);
          if (event.type === "message_stop") messageStopped = true;
        } catch (error) { reject(error); }
      },
      onMessage: (message) => {
        if (message.type !== "result") return;
        if (message.is_error || message.subtype !== "success") {
          reject(new ClaudeCodeBridgeError(message.errors?.join("; ") || message.result || "Claude Code model check failed", 502));
        } else if (!messageStopped) {
          reject(new ClaudeCodeBridgeError("Claude Code returned no completed model response", 502));
        } else resolve(accumulator.message);
      },
    });
    if (controller.signal.aborted) throw controller.signal.reason;
    worker.sendUserMessage("hi");
    return Response.json(await completed);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    await worker?.close();
  }
}
