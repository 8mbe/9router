import { createHash, randomUUID } from "node:crypto";
import { CLAUDE_CODE, CLAUDE_CODE_SESSION_STATE as STATE } from "../../config/claudeCodeConstants.js";
import { ROLE, CLAUDE_BLOCK } from "../../translator/schema/index.js";
import { ClaudeCodeBridgeError } from "./policy.js";
import { ClaudeMessageAccumulator, publicClaudeEvent, encodeClaudeEvent } from "./anthropicWire.js";
import { clientToolResultToMcp } from "./clientTools.js";

const sessions = new Map();

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, stable(value[key])]));
}

function withoutCacheHint(block) {
  if (!block || typeof block !== "object") return block;
  const { cache_control: _cacheHint, ...content } = block;
  return content;
}

function canonicalContent(content) {
  if (typeof content === "string") return [{ type: CLAUDE_BLOCK.TEXT, text: content }];
  if (!Array.isArray(content)) return content;
  return content.map(block => {
    const normalized = withoutCacheHint(block);
    if (normalized?.type === CLAUDE_BLOCK.TOOL_RESULT && Array.isArray(normalized.content)) normalized.content = normalized.content.map(withoutCacheHint);
    return normalized;
  });
}

const serialize = value => JSON.stringify(stable(value));
const fingerprint = value => createHash("sha256").update(serialize(value)).digest("hex");
const keyFor = (ownerId, provider, id) => serialize([ownerId, provider, id]);

function messagesOf(body) {
  if (!Array.isArray(body?.messages) || !body.messages.length) throw new ClaudeCodeBridgeError("Claude Code requires a user message");
  return body.messages.map(message => ({
    role: message.role,
    content: canonicalContent(message.content),
  }));
}

function resultsOf(body) {
  const last = body?.messages?.at(-1);
  return last?.role === ROLE.USER && Array.isArray(last.content) ? last.content.filter(block => block.type === CLAUDE_BLOCK.TOOL_RESULT) : [];
}

function expired() {
  return new ClaudeCodeBridgeError("Unknown or expired Claude Code conversation. Start a new conversation.", 409);
}

export function getClaudeCodeContinuation(body, { ownerId, provider, conversationId, strict = false } = {}) {
  if (conversationId) {
    const session = sessions.get(keyFor(ownerId, provider, conversationId));
    if (session) return { connectionId: session.connectionId, sessionId: session.id };
  }
  const results = resultsOf(body);
  const messages = messagesOf(body);
  if (messages.length === 1 && !results.length) return null;
  const candidates = [...sessions.values()].filter(session => session.ownerId === ownerId && session.provider === provider &&
    (!conversationId || session.id === conversationId) &&
    (results.length
      ? results.every(result => session.pending.has(result.tool_use_id)) || session.turns.has(fingerprint(messages))
      : serialize(messages.slice(0, -1)) === serialize(session.history) || session.turns.has(fingerprint(messages))));
  if (candidates.length !== 1) {
    const knownIds = results.some(result => [...sessions.values()].some(session => session.provider === provider && session.pending.has(result.tool_use_id)));
    if (strict || conversationId || knownIds || candidates.length > 1) throw expired();
    return null;
  }
  return { connectionId: candidates[0].connectionId, sessionId: candidates[0].id };
}

function defer() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

class Turn {
  constructor(session, hash) {
    this.session = session;
    this.hash = hash;
    this.events = [];
    this.accumulator = new ClaudeMessageAccumulator();
    this.first = defer();
    this.done = defer();
    this.subscribers = new Set();
    this.cleanups = [];
    this.finished = false;
    this.error = null;
    this.timeout = setTimeout(() => failSession(session, new ClaudeCodeBridgeError("Claude Code generation timed out", 504)), CLAUDE_CODE.generationTimeoutMs);
    this.timeout.unref?.();
  }

  add(event) {
    this.accumulator.add(event);
    const bytes = encodeClaudeEvent(event);
    this.byteLength = (this.byteLength || 0) + bytes.byteLength;
    if (this.byteLength > CLAUDE_CODE.maxResponseBytes) throw new ClaudeCodeBridgeError("Claude Code response exceeds the buffer limit", 502);
    this.events.push(event);
    this.first.resolve();
    for (const subscriber of this.subscribers) subscriber.enqueue(bytes);
  }

  finish(error = null) {
    if (this.finished) return;
    this.finished = true;
    this.error = error;
    clearTimeout(this.timeout);
    for (const cleanup of this.cleanups) cleanup();
    if (error) {
      this.first.reject(error);
      this.done.reject(error);
      const bytes = encodeClaudeEvent({ type: "error", error: { type: "api_error", message: error.message } });
      for (const subscriber of this.subscribers) { subscriber.enqueue(bytes); subscriber.close(); }
    } else {
      this.done.resolve(this.accumulator.message);
      for (const subscriber of this.subscribers) subscriber.close();
    }
    this.subscribers.clear();
  }

  bindSignal(signal) {
    if (!signal || this.finished) return;
    const cancel = () => failSession(this.session, new ClaudeCodeBridgeError("Claude Code request aborted", 499));
    if (signal.aborted) cancel();
    else {
      signal.addEventListener("abort", cancel, { once: true });
      this.cleanups.push(() => signal.removeEventListener("abort", cancel));
    }
  }

  stream() {
    let subscriber;
    return new ReadableStream({
      start: controller => {
        subscriber = controller;
        for (const event of this.events) controller.enqueue(encodeClaudeEvent(event));
        if (this.finished) {
          if (this.error) controller.enqueue(encodeClaudeEvent({ type: "error", error: { type: "api_error", message: this.error.message } }));
          controller.close();
        } else this.subscribers.add(controller);
      },
      cancel: () => {
        this.subscribers.delete(subscriber);
        if (!this.finished && !this.subscribers.size) failSession(this.session, new ClaudeCodeBridgeError("Claude Code client disconnected", 499));
      },
    });
  }
}

function failSession(session, error) {
  if (!sessions.has(session.key)) return;
  sessions.delete(session.key);
  session.state = STATE.FAILED;
  clearTimeout(session.idleTimer);
  session.activeTurn?.finish(error);
  // Interrupt Claude Code before rejecting its pending hook. Otherwise it can
  // interpret cancellation as a tool error and issue another model request.
  Promise.resolve(session.worker?.close()).catch(() => {}).finally(() => {
    for (const call of session.pending.values()) call.reject(error);
  });
}

function touch(session) {
  clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => failSession(session, expired()), CLAUDE_CODE.idleTimeoutMs);
  session.idleTimer.unref?.();
}

function onEvent(session, rawEvent) {
  if (!sessions.has(session.key)) return;
  try {
    const turn = session.activeTurn;
    if (!turn || turn.finished) {
      if (rawEvent.type === "ping") return;
      throw new ClaudeCodeBridgeError("Claude Code continued without a client request", 502);
    }
    const event = publicClaudeEvent(rawEvent, session.tools);
    if (event.type === "message_start" && session.consumedIds) {
      for (const id of session.consumedIds) session.pending.delete(id);
      session.consumedIds = null;
    }
    if (event.type === "content_block_start" && event.content_block?.type === CLAUDE_BLOCK.TOOL_USE) {
      const id = event.content_block.id;
      if (!id || session.pending.has(id)) throw new ClaudeCodeBridgeError("Duplicate upstream tool ID", 502);
      session.pending.set(id, { ...defer(), name: event.content_block.name });
    }
    turn.add(event);
    if (event.type === "message_stop") {
      const assistant = turn.accumulator.message;
      session.history.push({ role: ROLE.ASSISTANT, content: assistant.content });
      const hasTools = assistant.content.some(block => block.type === CLAUDE_BLOCK.TOOL_USE);
      session.state = hasTools ? STATE.WAITING : STATE.READY;
      turn.finish();
      touch(session);
    }
  } catch (error) { failSession(session, error); }
}

function validateBody(body) {
  if (Buffer.byteLength(JSON.stringify(body)) > CLAUDE_CODE.maxHistoryBytes) throw new ClaudeCodeBridgeError("Claude Code conversation exceeds the size limit", 413);
  const unsupported = ["temperature", "top_p", "top_k", "stop_sequences", "context_management", "container", "mcp_servers", "output_config"];
  for (const field of unsupported) if (body[field] !== undefined) throw new ClaudeCodeBridgeError(`Server Claude Code does not support ${field}; use direct execution for this request`);
  if (body.tool_choice && (body.tool_choice.type !== "auto" || body.tool_choice.disable_parallel_tool_use)) throw new ClaudeCodeBridgeError("Server Claude Code currently supports automatic tool choice only");
  if (body.thinking && body.thinking.type !== "disabled") throw new ClaudeCodeBridgeError("Server Claude Code thinking configuration is not supported yet; use direct execution");
  if (body.max_tokens !== undefined && (!Number.isInteger(body.max_tokens) || body.max_tokens < 1)) throw new ClaudeCodeBridgeError("max_tokens must be a positive integer");
  if (body.system !== undefined && typeof body.system !== "string" && (!Array.isArray(body.system) || body.system.some(block => block.type !== CLAUDE_BLOCK.TEXT))) throw new ClaudeCodeBridgeError("Server Claude Code supports text system instructions only");
  const tools = body.tools || [];
  if (!Array.isArray(tools)) throw new ClaudeCodeBridgeError("tools must be an array");
  const names = new Set();
  for (const tool of tools) {
    if (!tool || !/^[\w-]{1,64}$/.test(tool.name) || names.has(tool.name) || !tool.input_schema || (tool.type && tool.type !== "custom")) throw new ClaudeCodeBridgeError("Server Claude Code requires unique client tools with JSON input schemas");
    names.add(tool.name);
  }
}

export async function runClaudeCodeTurn({ body, ownerId, provider, connectionId, conversationId, model, createWorker, workerOptions, signal }) {
  validateBody(body);
  if (!ownerId) throw new ClaudeCodeBridgeError("Missing authenticated Claude Code conversation owner", 401);
  if (conversationId && (typeof conversationId !== "string" || conversationId.length > 128)) throw new ClaudeCodeBridgeError("Invalid Claude Code conversation ID");
  const messages = messagesOf(body);
  const last = messages.at(-1);
  if (last.role !== ROLE.USER || !Array.isArray(last.content) || !last.content.length) throw new ClaudeCodeBridgeError("Claude Code requires nonempty user content");
  const hash = fingerprint(messages);
  const configuration = fingerprint({ model, system: Array.isArray(body.system) ? body.system.map(withoutCacheHint) : body.system || "", tools: (body.tools || []).map(withoutCacheHint), max_tokens: body.max_tokens, thinking: body.thinking,
    upstreamBaseUrl: workerOptions?.upstreamBaseUrl, authMode: workerOptions?.authMode, apiKey: workerOptions?.apiKey });
  const continuation = getClaudeCodeContinuation(body, { ownerId, provider, conversationId, strict: true });
  const id = continuation?.sessionId || conversationId || randomUUID();
  const key = keyFor(ownerId, provider, id);
  let session = sessions.get(key);
  if (session) {
    if (session.connectionId !== connectionId || session.configuration !== configuration) throw new ClaudeCodeBridgeError("Claude Code connection, model, system or tools changed during this conversation", 409);
    const previous = session.turns.get(hash);
    if (previous) return { session, turn: previous };
    if (session.state === STATE.GENERATING) throw new ClaudeCodeBridgeError("A Claude Code generation is already in progress", 409);
    if (serialize(messages.slice(0, -1)) !== serialize(session.history)) throw new ClaudeCodeBridgeError("Claude Code conversation history changed; start a new conversation", 409);
  } else {
    if (sessions.size >= CLAUDE_CODE.maxSessions) throw new ClaudeCodeBridgeError("All server Claude Code workers are busy", 503);
    if (messages.length !== 1 || messages[0].role !== ROLE.USER || resultsOf(body).length) throw new ClaudeCodeBridgeError("Server Claude Code requires a new conversation; importing existing assistant history is not supported", 409);
    session = { key, id, ownerId, provider, connectionId, configuration, history: [], tools: structuredClone(body.tools || []), pending: new Map(), turns: new Map(), worker: null };
    sessions.set(key, session);
  }
  const results = resultsOf(body);
  if (session.state === STATE.WAITING) {
    if (results.length !== session.pending.size || results.length !== last.content.length || new Set(results.map(result => result.tool_use_id)).size !== results.length || results.some(result => !session.pending.has(result.tool_use_id))) throw new ClaudeCodeBridgeError("Provide exactly one tool_result for each pending Claude Code tool call", 409);
    if (Buffer.byteLength(JSON.stringify(results)) > CLAUDE_CODE.maxToolResultBytes) throw new ClaudeCodeBridgeError("Claude Code tool results exceed the size limit", 413);
    for (const result of results) {
      try { clientToolResultToMcp(result); }
      catch (error) { throw new ClaudeCodeBridgeError(error.message); }
    }
  } else if (results.length) throw expired();
  const turn = new Turn(session, hash);
  session.activeTurn = turn;
  session.turns.set(hash, turn);
  while (session.turns.size > 2) session.turns.delete(session.turns.keys().next().value);
  session.history = structuredClone(messages);
  session.state = STATE.GENERATING;
  clearTimeout(session.idleTimer);
  turn.bindSignal(signal);
  // Return the turn before releasing any tools, so callers can attach a consumer.
  turn.start = async () => {
    if (turn.started || turn.finished) return;
    turn.started = true;
    try {
      if (!session.worker) {
        session.worker = await createWorker({ ...workerOptions, model, system: body.system, tools: session.tools, maxTokens: body.max_tokens,
          onEvent: event => onEvent(session, event),
          onFailure: error => failSession(session, error),
          waitForToolResult: async (toolUseId, { signal: toolSignal } = {}) => {
            const call = session.pending.get(toolUseId);
            if (!call) throw new ClaudeCodeBridgeError("Unknown Claude Code tool invocation", 502);
            const timer = setTimeout(() => failSession(session, new ClaudeCodeBridgeError("Client tool result timed out", 504)), CLAUDE_CODE.toolResultTimeoutMs);
            timer.unref?.();
            const abort = () => call.reject(new ClaudeCodeBridgeError("Claude Code tool invocation aborted", 499));
            toolSignal?.addEventListener("abort", abort, { once: true });
            try { return await call.promise; }
            finally { clearTimeout(timer); toolSignal?.removeEventListener("abort", abort); }
          },
        });
        if (!sessions.has(key)) { await session.worker.close(); return; }
      }
      if (results.length) {
        const pending = session.pending;
        session.pending = new Map();
        // A handler may begin after the result POST, so retain settled calls until
        // the generation completes. New call IDs are appended to this map.
        for (const result of results) { const call = pending.get(result.tool_use_id); call.resolve(result); session.pending.set(result.tool_use_id, call); }
        session.consumedIds = new Set(results.map(result => result.tool_use_id));
      } else session.worker.sendUserMessage(last.content);
    } catch (error) { failSession(session, error); }
  };
  return { session, turn };
}

export async function closeClaudeCodeSessions() {
  const workers = [...sessions.values()].map(session => session.worker);
  for (const session of [...sessions.values()]) failSession(session, expired());
  await Promise.allSettled(workers.map(worker => worker?.close()));
}
