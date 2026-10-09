import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CLAUDE_CODE } from "../../config/claudeCodeConstants.js";
import { ROLE } from "../../translator/schema/index.js";
import { clientToolResultToMcp, createClientToolServer } from "./clientTools.js";

// Provider connections store either an API root or the usual /v1 base. The
// native Claude client appends /v1/messages itself.
export function normalizeClaudeCodeBaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/+$/, "")
    .replace(/\/messages$/, "")
    .replace(/\/v1$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

function createInputQueue() {
  const pending = [];
  let wake;
  let ended = false;
  return {
    push(message) {
      if (ended) throw new Error("Claude Code worker is closed");
      pending.push(message);
      wake?.();
      wake = undefined;
    },
    end() {
      ended = true;
      wake?.();
      wake = undefined;
    },
    async *[Symbol.asyncIterator]() {
      while (!ended) {
        if (pending.length) yield pending.shift();
        else await new Promise((resolve) => { wake = resolve; });
      }
    },
  };
}

// A worker only inherits process/runtime essentials. In particular, provider
// logins, endpoint overrides, proxies and CLAUDECODE from its host are excluded.
function createWorkerEnv({ upstreamBaseUrl, apiKey, authMode, configDir, maxTokens, runtimeHop }) {
  const env = {};
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SystemRoot", "TEMP", "TMP"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  Object.assign(env, {
    ANTHROPIC_BASE_URL: normalizeClaudeCodeBaseUrl(upstreamBaseUrl),
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
    ENABLE_TOOL_SEARCH: "false",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: "9router",
  });
  env[authMode === "bearer" ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY"] = apiKey;
  if (maxTokens !== undefined) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxTokens);
  if (runtimeHop) env.ANTHROPIC_CUSTOM_HEADERS = `${CLAUDE_CODE.runtimeHopHeader}: ${runtimeHop}`;
  return env;
}

/**
 * Run Claude Code against the configured API with client-owned tools only.
 * The worker stays alive across the client's separate Messages HTTP requests.
 * waitForToolResult(id, {name,input,signal}) returns an Anthropic tool_result.
 */
export async function createClaudeCodeWorker({
  model, system, tools = [], upstreamBaseUrl, apiKey, authMode = "api-key",
  cwd, onEvent, onFailure, waitForToolResult, signal, maxTokens, onMessage, runtimeHop,
}) {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const workspace = await mkdtemp(join(tmpdir(), "9router-claude-code-"));
  const configDir = join(workspace, "config");
  const isolatedCwd = cwd || join(workspace, "workspace");
  await mkdir(configDir, { recursive: true });
  if (!cwd) await mkdir(isolatedCwd, { recursive: true });
  const queue = createInputQueue();
  const controller = new AbortController();
  let sessionId;
  let activeCall;
  let closed = false;
  let failed = false;
  let closePromise;
  let sdkQuery;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Initialization may fail before a caller starts awaiting ready.
  ready.catch(() => {});

  function fail(error) {
    if (failed || closed) return;
    failed = true;
    rejectReady(error);
    // Failure handlers may close this worker. Awaiting that callback from the
    // reader would deadlock close(), which waits for the reader to finish.
    try { Promise.resolve(onFailure?.(error)).catch(() => {}); } catch { /* original failure is retained */ }
    void close(error).catch(() => {});
  }

  const server = createClientToolServer(tools, async (name, input) => {
    if (!activeCall || activeCall.name !== `${CLAUDE_CODE.mcpToolPrefix}${name}`
      || !isDeepStrictEqual(activeCall.input, input)) {
      const error = new Error("Claude Code client tool call did not match its PreToolUse ID and arguments");
      fail(error);
      throw error;
    }
    const call = activeCall;
    activeCall = undefined;
    return clientToolResultToMcp(call.result);
  });

  const beforeTool = async (input, toolUseId, { signal: hookSignal }) => {
    try {
      if (input.hook_event_name !== "PreToolUse" || !input.tool_name.startsWith(CLAUDE_CODE.mcpToolPrefix)) {
        throw new Error("Claude Code attempted a tool outside the client relay");
      }
      if (!toolUseId || activeCall) throw new Error("Claude Code client tool ID correlation failed");
      const originalInput = structuredClone(input.tool_input);
      const result = await waitForToolResult(toolUseId, {
        name: input.tool_name.slice(CLAUDE_CODE.mcpToolPrefix.length),
        input: input.tool_input,
        signal: hookSignal,
      });
      if (closed || controller.signal.aborted || hookSignal.aborted) {
        throw new Error("Claude Code client tool call was cancelled");
      }
      if (result?.tool_use_id !== toolUseId) throw new Error("Client tool result ID does not match Claude Code call");
      clientToolResultToMcp(result); // Validate before the hook permits its relay.
      activeCall = { id: toolUseId, name: input.tool_name, input: originalInput, result };
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
    } catch (error) {
      fail(error);
      throw error;
    }
  };

  const abortFromCaller = () => { void close(signal.reason).catch(() => {}); };

  try {
    if (signal?.aborted) throw signal.reason || new Error("Claude Code worker creation was cancelled");
    sdkQuery = query({
      prompt: queue,
      options: {
        model,
        systemPrompt: Array.isArray(system) ? system.map((block) => block.text) : system,
        tools: [],
        allowedTools: tools.map((tool) => `${CLAUDE_CODE.mcpToolPrefix}${tool.name}`),
        mcpServers: tools.length ? { [CLAUDE_CODE.mcpServerName]: server } : {},
        strictMcpConfig: true,
        settingSources: [],
        skills: [],
        settings: { disableBundledSkills: true },
        permissionMode: "dontAsk",
        thinking: { type: "disabled" },
        includePartialMessages: true,
        persistSession: false,
        verbatimPrompts: true,
        cwd: isolatedCwd,
        env: createWorkerEnv({ upstreamBaseUrl, apiKey, authMode, configDir, maxTokens, runtimeHop }),
        abortController: controller,
        hooks: { PreToolUse: [{ hooks: [beforeTool], timeout: CLAUDE_CODE.hookTimeoutSeconds }] },
      },
    });
  } catch (error) {
    signal?.removeEventListener("abort", abortFromCaller);
    await server.instance.close().catch(() => {});
    await rm(workspace, { recursive: true, force: true });
    throw error;
  }

  const done = (async () => {
    try {
      for await (const message of sdkQuery) {
        if (message.type === "system" && message.subtype === "init") {
          sessionId = message.session_id;
          const expectedTools = new Set(tools.map((tool) => `${CLAUDE_CODE.mcpToolPrefix}${tool.name}`));
          if (message.tools.some((name) => !expectedTools.has(name))
            || [...expectedTools].some((name) => !message.tools.includes(name))) {
            throw new Error("Claude Code initialized with an unexpected tool surface");
          }
          resolveReady(sessionId);
        }
        if (message.type === "stream_event") await onEvent?.(message.event);
        await onMessage?.(message);
        if (message.type === "result" && (message.is_error || message.subtype !== "success")) {
          throw new Error(message.errors?.join("; ") || message.result || "Claude Code worker failed");
        }
      }
      if (!closed && !controller.signal.aborted) throw new Error("Claude Code worker exited unexpectedly");
    } catch (error) {
      if (!closed) fail(error);
    } finally {
      queue.end();
      signal?.removeEventListener("abort", abortFromCaller);
    }
  })();

  async function close(reason) {
    if (closePromise) return closePromise;
    closed = true;
    rejectReady(reason || new Error("Claude Code worker closed before initialization"));
    queue.end();
    closePromise = (async () => {
      // Cancel the native agent turn before closing its transport. Closing a
      // pending hook alone can otherwise turn its cancellation into a tool
      // error and permit another request during graceful native shutdown.
      let timer;
      await Promise.race([
        sdkQuery.interrupt().catch(() => {}),
        new Promise((resolve) => { timer = setTimeout(resolve, CLAUDE_CODE.shutdownTimeoutMs); }),
      ]);
      clearTimeout(timer);
      controller.abort(reason);
      sdkQuery.close();
      await done;
      await server.instance.close().catch(() => {});
      await rm(workspace, { recursive: true, force: true });
    })();
    return closePromise;
  }

  signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (signal?.aborted) abortFromCaller();

  return {
    ready,
    done,
    get sessionId() { return sessionId; },
    get closed() { return closed || failed; },
    sendUserMessage(content) {
      if (closed || failed || controller.signal.aborted) throw new Error("Claude Code worker is closed");
      queue.push({
        type: ROLE.USER,
        uuid: randomUUID(),
        session_id: sessionId || "",
        message: { role: ROLE.USER, content },
        parent_tool_use_id: null,
      });
    },
    close,
  };
}
