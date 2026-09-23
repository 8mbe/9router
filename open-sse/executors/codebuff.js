import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { dbg } from "../utils/debugLog.js";
import { randomUUID } from "crypto";

/**
 * Codebuff ("Freebuff") free-tier executor.
 *
 * The chat route is OpenAI-shaped but is NOT a plain OpenAI endpoint. A chat
 * call only succeeds when it is made the way the official CLI makes it:
 *
 *   1. an admitted session  (POST /api/v1/freebuff/session/admission) — this is
 *      what actually costs credits: one session-hour charged at admission,
 *      refunded on an early DELETE;
 *   2. a registered agent run (POST /api/v1/agent-runs, action START), whose
 *      run_id / client_id / trace_session_id are stable for the run's lifetime;
 *   3. a request envelope carrying those identifiers plus the run's canonical
 *      root system-prompt opening.
 *
 * Miss any of them and upstream answers 403 free_mode_cli_required. Mint a
 * fresh client_id per call inside one run and it answers free_mode_run_fanout.
 *
 * Reference: trefeon/freebucks-proxy (Go), whose wire comments document the
 * upstream shapes this file mirrors.
 */

const BASE_URL = "https://www.codebuff.com";
const CHAT_PATH = "/api/v1/chat/completions";
const SESSION_ADMISSION_PATH = "/api/v1/freebuff/session/admission";
const SESSION_PATH = "/api/v1/freebuff/session";
const AGENT_RUNS_PATH = "/api/v1/agent-runs";

// The CLI pins the ai-sdk provider UA on chat calls ONLY. Every other upstream
// call it makes goes through a bare Bun fetch, which sends Bun's own default
// UA. Sending the chat UA on a session call is itself a mismatch.
const CHAT_USER_AGENT = "ai-sdk/openai-compatible/1.0.0/codebuff";
const BUN_USER_AGENT = "Bun/1.3.14";

const SESSION_CALL_TIMEOUT_MS = 30_000;
// Runs rotate on a long interval (upstream ROTATION_INTERVAL default 6h) and
// are FINISHed once the account's seat has been idle for a while.
const RUN_ROTATION_MS = 6 * 60 * 60 * 1000;
const RUN_IDLE_FINISH_MS = 30 * 60 * 1000;
// A session is a purchased hour. Re-admit slightly before it lapses so a chat
// never lands on an expired instance.
const SESSION_EXPIRY_BUFFER_MS = 60_000;
// Idle seat: DELETE the session to reclaim the unused part of the hour.
const SESSION_IDLE_RELEASE_MS = 30 * 60 * 1000;
const CAPACITY_DEFERRED_RETRIES = 1;
const CAPACITY_DEFERRED_FLOOR_MS = 10_000;

// ── canonical root identities ────────────────────────────────────────────────
// The free-mode gate is a TRIMMED PREFIX test at position 0 of a system
// message against any of these five openings. Prepending is only correct when
// none of them already opens the prompt — a prompt that passes the gate must
// be left alone.
const BASE2_MARKER =
  "You are Buffy, the strategic coding assistant. You are the AI agent behind the product, Freebuff, a tool where users can chat with you to code with AI for free.";
const BASE3_MARKER = "You are Buffy, the coding agent behind Codebuff.";
const GATE_OPENINGS = [
  "You are Buffy, the strategic coding assistant",
  "You are Buffy, the coding agent behind Codebuff.",
  "You are Buffy, the Freebuff Cloud project planner.",
  "You are Buffy, the auto-run agent behind Freebuff Desktop.",
  "You are Buffy, a strategic assistant that orchestrates complex coding tasks through specialized sub-agents.",
];

// Upstream scans every system message for these and refuses the request as a
// foreign harness. 9router's most common clients (Claude Code, Gemini CLI,
// Crush) send several of them verbatim, so they are replaced with nothing
// while the surrounding instructions are preserved.
const FOREIGN_HARNESS_MARKERS = [
  "You are Claude Code",
  "Anthropic's official CLI",
  "cc_version=",
  "cc_entrypoint=",
  "You are Kimi Code CLI",
  "You are Hermes Agent, built by Nous Research",
  "You are a general-purpose AI agent called goose",
  "You are an expert on the AI coding tool called Aider",
  "Gemini CLI",
  "Generated with Crush",
  "Assisted-by: Crush",
  "Co-Authored-By: Crush",
  "Co-Authored-By: Claude Code",
  "*** Begin Patch",
  "*** End Patch",
];

// Root agent id per model. The base3 roots are what upstream's own CLI sends
// for the models that have one; a model without a base3 twin keeps its base2
// root (running a DIFFERENT model's root is a session_model_mismatch 403).
const BASE3_AGENT_BY_MODEL = {
  "deepseek/deepseek-v4-flash": "base3-free-deepseek-flash",
  "mimo/mimo-v2.5": "base3-free-mimo",
  "openai/gpt-6-luna": "base3-free-luna-6",
  "z-ai/glm-5.3-flash": "base3-free-glm-5-3-flash",
  "upstage/solar-pro4": "base3-free-solar-pro4",
  "meta/muse-spark-1.2-contributor": "base3-free-muse-spark",
};
const BASE2_AGENT_BY_MODEL = {
  "deepseek/deepseek-v4-flash": "base2-free-deepseek-flash",
  "mimo/mimo-v2.5": "base2-free-mimo",
  "openai/gpt-6-luna": "base2-free-luna-6",
  "z-ai/glm-5.3-flash": "base2-free-glm-5-3-flash",
  "upstage/solar-pro4": "base2-free-solar-pro4",
  "meta/muse-spark-1.2-contributor": "base2-free-muse-spark",
};

function agentIdForModel(model) {
  return BASE3_AGENT_BY_MODEL[model] || BASE2_AGENT_BY_MODEL[model] || "base2-free";
}

function markerForAgent(agentId) {
  return agentId.startsWith("base3") ? BASE3_MARKER : BASE2_MARKER;
}

// ── wire codes ───────────────────────────────────────────────────────────────
const CODE_CAPACITY_DEFERRED = "free_mode_capacity_deferred";
const CODE_WAITING_ROOM = "waiting_room_required";
// Any of these means the lease we hold is dead; re-admit and retry once.
const SESSION_INVALID_CODES = [
  "session_expired",
  "session_superseded",
  "session_model_mismatch",
  "model_locked",
  "free_mode_legacy_luna_agent",
  "free_mode_legacy_luna",
];
// The run is dead but the session is fine: START a new run and retry once.
const RUN_INVALID_CODES = ["runid not found", "runid not running", "free_mode_run_fanout"];

function bodyHasCode(text, codes) {
  const lower = (text || "").toLowerCase();
  return codes.some((c) => lower.includes(c));
}

// ── per-account state ────────────────────────────────────────────────────────
// Keyed by connection id: one Codebuff account = one seat = one session.
const sessions = new Map(); // key → { instanceId, model, expiresAt, lastUsed, admitting }
const runs = new Map();     // key → { runId, agentId, clientId, traceSessionId, startedAt, lastUsed, steps, stepNumber }

const maintenance = setInterval(() => {
  const now = Date.now();
  for (const [key, run] of runs) {
    if (now - run.lastUsed > RUN_IDLE_FINISH_MS) {
      runs.delete(key);
      finishRun(run, run.token, run.proxyOptions).catch(() => {});
    }
  }
  for (const [key, session] of sessions) {
    if (!session.admitting && now - session.lastUsed > SESSION_IDLE_RELEASE_MS) {
      sessions.delete(key);
      releaseSession(session, session.token, session.proxyOptions).catch(() => {});
    }
  }
}, 60_000);
if (maintenance.unref) maintenance.unref();

function accountKey(credentials) {
  return credentials?.connectionId || credentials?.accessToken?.slice(-16) || "default";
}

// The server picks the account's daily-reset zone from this header. It is a
// scheduling preference, not a location claim.
function localTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * client_id shape the ai-sdk mints: 13 chars of base36, no prefix.
 * The `sess:`/`run:`-prefixed and `wf-xxxxxxxx` forms upstream fingerprints as
 * proxy traffic must never appear here.
 */
function generateClientId() {
  return Math.random().toString(36).substring(2, 15).padEnd(13, "0").slice(0, 13);
}

function controlHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "User-Agent": BUN_USER_AGENT,
    "x-fb-timezone": localTimezone(),
  };
}

async function controlFetch(url, options, proxyOptions) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("codebuff control call timeout")), SESSION_CALL_TIMEOUT_MS);
  try {
    return await proxyAwareFetch(url, { ...options, signal: ctrl.signal }, proxyOptions);
  } finally {
    clearTimeout(timer);
  }
}

// ── session lifecycle ────────────────────────────────────────────────────────

/**
 * POST the admission route. The POST carries NO body, and therefore no
 * Content-Type — the CLI's session POST is a bare fetch with Authorization,
 * the model header and the wallet spend limit.
 */
async function admitSession(token, model, proxyOptions, log) {
  const response = await controlFetch(`${BASE_URL}${SESSION_ADMISSION_PATH}`, {
    method: "POST",
    headers: {
      ...controlHeaders(token),
      "x-freebuff-model": model,
      // The proxy holds no user-confirmed spend cap, so it sends the server
      // default, exactly like a CLI POST with no explicit pick.
      "x-freebuff-wallet-spend-limit": "0",
    },
  }, proxyOptions);

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Codebuff session admission failed (${response.status}): ${text.slice(0, 300)}`);
  }

  let state;
  try {
    state = JSON.parse(text);
  } catch {
    throw new Error(`Codebuff session admission returned non-JSON: ${text.slice(0, 200)}`);
  }

  if (state.status === "banned" || state.status === "country_blocked") {
    throw new Error(`Codebuff account unavailable: ${state.status}${state.message ? ` — ${state.message}` : ""}`);
  }
  if (state.status === "model_unavailable") {
    throw new Error(
      `Codebuff model ${model} is unavailable${state.availableHours ? ` (available ${state.availableHours})` : ""}${state.message ? ` — ${state.message}` : ""}`
    );
  }
  if (!state.instanceId) {
    throw new Error(`Codebuff session admission returned status "${state.status}" with no instanceId`);
  }

  const expiresAt = state.remainingMs > 0
    ? Date.now() + state.remainingMs
    : state.expiresAt
      ? new Date(state.expiresAt).getTime()
      : Date.now() + 3600_000;

  log?.debug?.("CODEBUFF", `session admitted ${state.instanceId} model=${model} status=${state.status}`);
  dbg("CODEBUFF", `session admitted instance=${state.instanceId} freebucks=${state.freebucks?.balance ?? "?"}`);

  return { instanceId: state.instanceId, model, expiresAt, status: state.status };
}

/** DELETE the session to refund the unused part of the purchased hour. */
async function releaseSession(session, token, proxyOptions) {
  if (!session?.instanceId || !token) return;
  try {
    await controlFetch(`${BASE_URL}${SESSION_PATH}`, {
      method: "DELETE",
      headers: { ...controlHeaders(token), "x-freebuff-instance-id": session.instanceId },
    }, proxyOptions);
    dbg("CODEBUFF", `session released ${session.instanceId}`);
  } catch {
    // Best-effort: an unreleased seat just lapses at the end of its hour.
  }
}

/**
 * Return a live session for this account, admitting one if needed.
 * Concurrent requests share one in-flight admission — two admissions would
 * buy (and pay for) two hours.
 */
async function ensureSession(key, token, model, proxyOptions, log, { force = false } = {}) {
  const existing = sessions.get(key);

  if (!force && existing) {
    if (existing.admitting) return existing.admitting;
    if (existing.model === model && existing.expiresAt - SESSION_EXPIRY_BUFFER_MS > Date.now()) {
      existing.lastUsed = Date.now();
      return existing;
    }
  }

  // Switching model or replacing a dead lease: give the old hour back first.
  if (existing && !existing.admitting) {
    sessions.delete(key);
    releaseSession(existing, token, proxyOptions).catch(() => {});
  }

  const placeholder = { admitting: null, token, proxyOptions, lastUsed: Date.now() };
  const promise = admitSession(token, model, proxyOptions, log)
    .then((session) => {
      const entry = { ...session, token, proxyOptions, lastUsed: Date.now(), admitting: null };
      sessions.set(key, entry);
      return entry;
    })
    .catch((err) => {
      sessions.delete(key);
      throw err;
    });
  placeholder.admitting = promise;
  sessions.set(key, placeholder);
  return promise;
}

// ── run lifecycle ────────────────────────────────────────────────────────────

/**
 * POST agent-runs START. These POSTs carry BOTH Authorization and
 * x-codebuff-api-key with the same raw token — that is the agent-runtime's
 * own wire shape, and a run registered with only one of them looks wrong.
 */
async function startRun(token, agentId, proxyOptions) {
  const response = await controlFetch(`${BASE_URL}${AGENT_RUNS_PATH}`, {
    method: "POST",
    headers: {
      ...controlHeaders(token),
      "Content-Type": "application/json",
      "x-codebuff-api-key": token,
    },
    body: JSON.stringify({ action: "START", agentId, ancestorRunIds: [] }),
  }, proxyOptions);

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Codebuff run START failed (${response.status}): ${text.slice(0, 300)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Codebuff run START returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (!parsed.runId) {
    throw new Error(`Codebuff run START response missing runId: ${text.slice(0, 200)}`);
  }
  return parsed.runId;
}

/**
 * POST agent-runs FINISH with the run's recorded steps. The CLI has no /steps
 * endpoint — steps ride the FINISH payload in one request.
 */
async function finishRun(run, token, proxyOptions) {
  if (!run?.runId || !token) return;
  try {
    await controlFetch(`${BASE_URL}${AGENT_RUNS_PATH}`, {
      method: "POST",
      headers: {
        ...controlHeaders(token),
        "Content-Type": "application/json",
        "x-codebuff-api-key": token,
      },
      body: JSON.stringify({
        action: "FINISH",
        runId: run.runId,
        status: "completed",
        totalSteps: run.steps.length || run.stepNumber,
        directCredits: 0,
        totalCredits: 0,
        steps: run.steps,
      }),
    }, proxyOptions);
    dbg("CODEBUFF", `run finished ${run.runId} steps=${run.steps.length}`);
  } catch {
    // Best-effort bookkeeping; a dangling run does not block the next one.
  }
}

/**
 * Get the account's current run for this agent, rotating it on age.
 * client_id and trace_session_id are minted ONCE per run and repeated by every
 * chat call of that run — a fresh draw per call is exactly the fan-out shape
 * upstream refuses.
 */
async function ensureRun(key, token, agentId, proxyOptions, { force = false } = {}) {
  const runKey = `${key}:${agentId}`;
  const existing = runs.get(runKey);

  if (!force && existing && Date.now() - existing.startedAt < RUN_ROTATION_MS) {
    existing.lastUsed = Date.now();
    return existing;
  }

  if (existing) {
    runs.delete(runKey);
    finishRun(existing, token, proxyOptions).catch(() => {});
  }

  const runId = await startRun(token, agentId, proxyOptions);
  const run = {
    runId,
    agentId,
    clientId: generateClientId(),
    traceSessionId: randomUUID(),
    startedAt: Date.now(),
    lastUsed: Date.now(),
    stepNumber: 0,
    steps: [],
    token,
    proxyOptions,
  };
  runs.set(runKey, run);
  return run;
}

// ── request envelope ─────────────────────────────────────────────────────────

function scrubForeignMarkers(text) {
  let out = text;
  for (const marker of FOREIGN_HARNESS_MARKERS) {
    if (out.includes(marker)) out = out.split(marker).join("");
  }
  return out;
}

function scrubContent(content) {
  if (typeof content === "string") return scrubForeignMarkers(content);
  if (Array.isArray(content)) {
    return content.map((part) =>
      part && typeof part === "object" && typeof part.text === "string"
        ? { ...part, text: scrubForeignMarkers(part.text) }
        : part
    );
  }
  return content;
}

function hasCanonicalOpening(text) {
  const trimmed = String(text).replace(/^[\s]+/, "");
  return GATE_OPENINGS.some((opening) => trimmed.startsWith(opening));
}

/**
 * Guarantee the run's canonical opening at position 0 of the first system
 * message. Prepends rather than replaces, so the caller's own instructions
 * survive; leaves a prompt that already opens with ANY of the five canonical
 * identities untouched (the gate is any-of-five, and re-prepending would break
 * a prompt that already passes).
 */
function ensureSystemMarker(payload, agentId) {
  const marker = markerForAgent(agentId);
  const messages = Array.isArray(payload.messages) ? [...payload.messages] : [];

  if (messages.length === 0) {
    payload.messages = [{ role: "system", content: marker }];
    return;
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== "system" || msg.content === undefined) continue;
    messages[i] = { ...msg, content: scrubContent(msg.content) };
  }

  for (const msg of messages) {
    if (!msg || msg.role !== "system") continue;
    if (typeof msg.content === "string" && hasCanonicalOpening(msg.content)) {
      payload.messages = messages;
      return;
    }
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part && typeof part.text === "string" && hasCanonicalOpening(part.text)) {
          payload.messages = messages;
          return;
        }
      }
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== "system") continue;
    if (typeof msg.content === "string") {
      const trimmed = msg.content.trim();
      messages[i] = { ...msg, content: trimmed ? `${marker}\n\n${msg.content}` : marker };
    } else if (Array.isArray(msg.content)) {
      messages[i] = { ...msg, content: [{ type: "text", text: marker }, ...msg.content] };
    } else {
      messages[i] = { ...msg, content: marker };
    }
    payload.messages = messages;
    return;
  }

  payload.messages = [{ role: "system", content: marker }, ...messages];
}

const RESERVED_METADATA_KEYS = new Set([
  "run_id",
  "client_id",
  "trace_session_id",
  "freebuff_instance_id",
  "llm_step_number",
  "cost_mode",
  "freebuff_reasoning_effort",
]);

/**
 * Merge the CLI fingerprint into the request body without disturbing
 * client-supplied fields. Reserved identifiers are always proxy-minted, so a
 * caller cannot smuggle its own; non-reserved extras are forwarded verbatim.
 */
function injectEnvelope(body, { run, instanceId, stepNumber }) {
  const payload = { ...body };

  ensureSystemMarker(payload, run.agentId);

  const metadata = {};
  const existing = payload.codebuff_metadata;
  if (existing && typeof existing === "object") {
    for (const [k, v] of Object.entries(existing)) {
      if (!RESERVED_METADATA_KEYS.has(k)) metadata[k] = v;
    }
  }

  metadata.run_id = run.runId;
  metadata.client_id = run.clientId;
  metadata.trace_session_id = run.traceSessionId;
  if (instanceId) metadata.freebuff_instance_id = instanceId;
  if (stepNumber > 0) metadata.llm_step_number = String(stepNumber);
  metadata.cost_mode = "free";
  // This — not the top-level field — is what the upstream effort authority
  // reads. Absent when the caller asked for none, so upstream applies its own
  // catalog default.
  if (typeof payload.reasoning_effort === "string" && payload.reasoning_effort) {
    metadata.freebuff_reasoning_effort = payload.reasoning_effort;
  }

  payload.codebuff_metadata = metadata;
  payload.provider = { data_collection: "deny" };
  payload.stream = true;

  return payload;
}

// ── executor ─────────────────────────────────────────────────────────────────

export class CodebuffExecutor extends BaseExecutor {
  constructor() {
    super("codebuff", PROVIDERS["codebuff"]);
  }

  buildUrl() {
    return `${BASE_URL}${CHAT_PATH}`;
  }

  buildHeaders(credentials) {
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${credentials.accessToken || credentials.apiKey}`,
      Accept: "application/json, text/event-stream",
      // Chat is the only path carrying the ai-sdk UA.
      "User-Agent": CHAT_USER_AGENT,
    };
    // The CLI sends this on every chat call with the account's OWN id, and the
    // server honors it only for its own service account. Any other value
    // impersonates a foreign user, so it is sent only when it came from this
    // token's /api/v1/me.
    const ownId = credentials?.providerSpecificData?.codebuffUserId;
    if (ownId) headers["x-freebuff-acting-user-id"] = ownId;
    return headers;
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const token = credentials?.accessToken || credentials?.apiKey;
    if (!token) throw new Error("Codebuff requires an OAuth connection");

    const key = accountKey(credentials);
    const agentId = agentIdForModel(model);
    const url = this.buildUrl();
    const headers = this.buildHeaders(credentials);

    let session = await ensureSession(key, token, model, proxyOptions, log);
    let run = await ensureRun(key, token, agentId, proxyOptions);

    let sessionRetried = false;
    let runRetried = false;
    let capacityAttempts = 0;
    let transformedBody = null;

    for (;;) {
      run.stepNumber += 1;
      const stepNumber = run.stepNumber;
      const stepStart = new Date().toISOString();
      transformedBody = injectEnvelope(body, {
        run,
        instanceId: session.instanceId,
        stepNumber,
      });

      const response = await proxyAwareFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(transformedBody),
        signal,
      }, proxyOptions);

      if (response.ok) {
        run.lastUsed = Date.now();
        session.lastUsed = Date.now();
        return {
          response: this.#wrapStream(response, run, stepNumber, stepStart),
          url,
          headers,
          transformedBody,
        };
      }

      const text = await response.text();
      dbg("CODEBUFF", `chat ${response.status}: ${text.slice(0, 200)}`);

      // Free-tier capacity queue: upstream asks the client to WAIT and retry
      // the SAME session. Never a session invalidation.
      if (bodyHasCode(text, [CODE_CAPACITY_DEFERRED]) && capacityAttempts < CAPACITY_DEFERRED_RETRIES) {
        capacityAttempts += 1;
        const retryAfter = Math.max(
          CAPACITY_DEFERRED_FLOOR_MS,
          Number(response.headers?.get?.("retry-after")) * 1000 || 0
        );
        log?.debug?.("CODEBUFF", `capacity deferred, retrying same session in ${retryAfter}ms`);
        await new Promise((resolve) => setTimeout(resolve, retryAfter));
        continue;
      }

      if (!sessionRetried && bodyHasCode(text, SESSION_INVALID_CODES)) {
        sessionRetried = true;
        log?.debug?.("CODEBUFF", "session rejected upstream, re-admitting");
        session = await ensureSession(key, token, model, proxyOptions, log, { force: true });
        continue;
      }

      if (!runRetried && bodyHasCode(text, RUN_INVALID_CODES)) {
        runRetried = true;
        log?.debug?.("CODEBUFF", "run rejected upstream, starting a new run");
        run = await ensureRun(key, token, agentId, proxyOptions, { force: true });
        continue;
      }

      if (bodyHasCode(text, [CODE_WAITING_ROOM])) {
        // The pre-session waiting room needs a human-facing chain the gateway
        // deliberately does not automate. Surface it honestly.
        return {
          response: new Response(text, { status: 429, headers: { "Content-Type": "application/json" } }),
          url,
          headers,
          transformedBody,
        };
      }

      // Anything else: hand the upstream status and body to the core error path.
      return {
        response: new Response(text, {
          status: response.status,
          headers: { "Content-Type": response.headers?.get?.("content-type") || "application/json" },
        }),
        url,
        headers,
        transformedBody,
      };
    }
  }

  /**
   * Pass the upstream SSE through untouched while recording the step the run
   * will report at FINISH. The CLI records one step per completed chat call,
   * carrying the response's message id.
   */
  #wrapStream(response, run, stepNumber, stepStart) {
    if (!response.body) return response;

    let messageId = null;
    let buffer = "";
    const decoder = new TextDecoder();

    const transform = new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        if (messageId) return;
        buffer += decoder.decode(chunk, { stream: true });
        const match = buffer.match(/"id"\s*:\s*"([^"]+)"/);
        if (match) {
          messageId = match[1];
          buffer = "";
        } else if (buffer.length > 8192) {
          buffer = buffer.slice(-1024);
        }
      },
      flush() {
        run.steps.push({
          id: randomUUID(),
          stepNumber,
          messageId,
          status: "completed",
          startTime: stepStart,
        });
        run.lastUsed = Date.now();
      },
    });

    return new Response(response.body.pipeThrough(transform), {
      status: response.status,
      headers: response.headers,
    });
  }

  // Upstream issues no refresh token: a 401 means the CLI token is gone and
  // the user must log in again. Returning null makes chatCore surface that
  // instead of looping on a refresh that cannot exist.
  async refreshCredentials() {
    return null;
  }

  needsRefresh() {
    return false;
  }
}

export default CodebuffExecutor;
