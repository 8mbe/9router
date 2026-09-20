/**
 * ClineFreeExecutor — runs the free Cline tier IN-PROCESS, with no external
 * server to install or start.
 *
 * This is the cline-api bridge (https://github.com/alesrg/cline-api, MIT) folded
 * into 9router: instead of POSTing to a separate loopback HTTP server, we load
 * `@cline/core` here and drive it directly, then synthesize OpenAI-compatible
 * SSE ourselves. `cline` is an optionalDependency, so the core ships with
 * 9router; a global `npm i -g cline` install is also accepted as a fallback.
 *
 * Flow:
 *   1. Resolve + import @cline/core once (cached), seeding CLINE_DATA_DIR from
 *      the user's real `cline auth` session so the SDK finds the saved token.
 *   2. Flatten the OpenAI messages into one Cline prompt; system messages become
 *      the systemPrompt.
 *   3. ClineCore.create() → subscribe() for text deltas → start() for the turn.
 *   4. Emit chunks as OpenAI chat.completion.chunk SSE (or one JSON body when
 *      the caller did not ask for a stream).
 *
 * Auth: none of our own. Cline's own OAuth session (`cline auth`) is read from
 * ~/.cline; there is no API key to store in 9router.
 *
 * Tools: OFF by default. Cline's tools are real fs/shell access running as the
 * 9router process user, so they stay opt-in behind CLINE_ENABLE_TOOLS=1 +
 * CLINE_WORKSPACE_ROOT. OpenAI function tools are a different thing entirely and
 * are not supported by Cline — they are stripped in translator/concerns/paramSupport.js.
 */

import path from "node:path";
import fsPromises from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { BaseExecutor } from "./base.js";
import { clineRealSettingsPath, clineAuthDir } from "../shared/clineLocalAuth.js";
import {
  PROVIDERS,
  CLINE_INPROCESS_URL,
  resolveClineWorkspaceRoot,
  clineToolsEnabled,
} from "../config/providers.js";

const PROVIDER_ID = "cline-free";
// Cline's own provider id inside the SDK (CFG.defaultProvider in cline-api).
const CLINE_PROVIDER_ID = "cline";
// server.mjs numberOption bounds — kept so a client asking for more is clamped
// rather than rejected.
const BUDGET_MIN = 1;
const BUDGET_MAX = 100000;
const DISPOSE_TIMEOUT_MS = 5000;

const DEFAULT_SYSTEM_PROMPT =
  "You are Cline, an autonomous AI coding agent. You can read files, search " +
  "codebases, run shell commands, and edit files to accomplish the task. " +
  "When files are attached, inspect them with your tools before answering. " +
  "Be precise and concise.";

// ─── @cline/core resolution ──────────────────────────────────────────────────

const require_ = createRequire(import.meta.url);

async function exists(p) {
  if (!p) return false;
  try {
    await fsPromises.access(p);
    return true;
  } catch {
    return false;
  }
}

// Bundled install first (optionalDependency), then a global `npm i -g cline`.
// Mirrors cline-api's probe list so an existing global install keeps working.
function candidateCorePaths() {
  const out = [];
  const envPath = process.env.CLINE_CORE_INDEX?.trim();
  if (envPath) out.push(envPath);

  // Bundled: node_modules/@cline/core (hoisted) or under node_modules/cline.
  for (const spec of ["@cline/core/dist/index.js", "cline/node_modules/@cline/core/dist/index.js"]) {
    try {
      out.push(require_.resolve(spec));
    } catch { /* not installed here — fall through to the global probes */ }
  }

  const nested = path.join("cline", "node_modules", "@cline", "core", "dist", "index.js");
  for (const root of (process.env.NODE_PATH || "").split(path.delimiter).filter(Boolean)) {
    out.push(path.join(root, nested));
  }
  if (process.env.APPDATA) out.push(path.join(process.env.APPDATA, "npm", "node_modules", nested));
  const execDir = path.dirname(process.execPath);
  out.push(path.join(execDir, "node_modules", nested));
  out.push(path.join(path.dirname(execDir), "lib", "node_modules", nested));
  out.push(path.join("/usr/local/lib/node_modules", nested));
  out.push(path.join("/usr/lib/node_modules", nested));
  return out;
}

export async function resolveClineCoreIndex() {
  for (const candidate of candidateCorePaths()) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

// The on-disk `cline auth` session lives in shared/clineLocalAuth.js so the
// model-list service can read it without importing this executor. Re-exported
// here because the executor is this module's public face for those paths.
export { clineHome, clineRealSettingsPath, clineAuthDir } from "../shared/clineLocalAuth.js";

export async function seedClineAuth() {
  const source = clineRealSettingsPath();
  if (!(await exists(source))) {
    const err = new Error(
      "Cline is not logged in — run `cline auth` (the CLI ships with 9router: `npx cline auth`)."
    );
    err.status = 401;
    throw err;
  }
  const authDir = clineAuthDir();
  await fsPromises.mkdir(path.join(authDir, "settings"), { recursive: true });
  await fsPromises.copyFile(source, path.join(authDir, "settings", "providers.json"));
  process.env.CLINE_DATA_DIR = authDir;
  return authDir;
}

let corePromise = null;
export async function loadClineCore() {
  if (!corePromise) {
    corePromise = (async () => {
      const index = await resolveClineCoreIndex();
      if (!index) {
        const err = new Error(
          "@cline/core not found. It ships with 9router as an optional dependency — "
          + "reinstall with `npm install`, or `npm i -g cline`, or set CLINE_CORE_INDEX."
        );
        err.status = 503;
        throw err;
      }
      const mod = await import(pathToFileURL(index).href);
      if (!mod?.ClineCore) throw new Error(`@cline/core at ${index} exports no ClineCore`);
      return mod.ClineCore;
    })().catch((e) => { corePromise = null; throw e; });
  }
  return corePromise;
}

// ─── OpenAI body → Cline turn ────────────────────────────────────────────────

export function extractText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && part.type === "text" && typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return String(content);
}

// Cline takes one prompt string, not a message list, so the turn history is
// flattened into tagged blocks and the system messages are hoisted out.
export function buildPrompt(messages) {
  const lines = [];
  for (const m of messages || []) {
    if (!m || typeof m !== "object") continue;
    const role = String(m.role || "user");
    if (role === "system") continue;
    const text = extractText(m.content);
    if (!text) continue;
    lines.push(`<message role="${role}">\n${text}\n</message>`);
  }
  return lines.join("\n\n");
}

export function buildSystemPrompt(body) {
  if (typeof body?.system === "string" && body.system.trim()) return body.system;
  const fromMessages = (body?.messages || [])
    .filter((m) => m?.role === "system")
    .map((m) => extractText(m.content))
    .filter(Boolean)
    .join("\n\n");
  return fromMessages || DEFAULT_SYSTEM_PROMPT;
}

function clamp(value, min, max) {
  return Math.min(Math.max(Math.round(value), min), max);
}

// 9router emits provider-native thinking shapes (zai `{type:"enabled"}`, claude
// `{type, budget_tokens}`); Cline's config takes a boolean plus a separate budget.
export function normalizeThinkingForCline(body) {
  const out = { thinking: undefined, thinkingBudgetTokens: undefined };
  const raw = body?.thinking;
  if (typeof raw === "boolean") out.thinking = raw;
  else if (raw && typeof raw === "object") {
    out.thinking = typeof raw.type === "string" ? raw.type !== "disabled" : true;
    const budget = Number(raw.budget_tokens ?? raw.thinkingBudget);
    if (Number.isFinite(budget) && budget > 0) out.thinkingBudgetTokens = clamp(budget, BUDGET_MIN, BUDGET_MAX);
  }
  // zai turns thinking off with enable_thinking:false and no `thinking` key.
  if (out.thinking === undefined && body?.enable_thinking !== undefined) {
    out.thinking = !!body.enable_thinking;
  }
  if (out.thinking === false) out.thinkingBudgetTokens = undefined;
  else if (out.thinkingBudgetTokens === undefined && Number.isFinite(Number(body?.thinking_budget_tokens))) {
    out.thinkingBudgetTokens = clamp(Number(body.thinking_budget_tokens), BUDGET_MIN, BUDGET_MAX);
  }
  return out;
}

// ─── Cline agent stream envelopes ────────────────────────────────────────────

// Cline streams a turn as newline JSON "envelopes"; pull the clean text delta.
export function envDelta(raw) {
  let o;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const isText = (o.type === "content_start" || o.type === "content_delta")
    && o.contentType === "text" && typeof o.text === "string" && o.text.length > 0;
  return isText ? o.text : null;
}

export function envDoneText(raw) {
  try {
    const o = JSON.parse(raw);
    if (o?.type === "done" && typeof o.text === "string") return o.text;
  } catch { /* not an envelope */ }
  return null;
}

// Cline reports quota/billing failures as ordinary assistant text, so they must be
// re-raised as real errors or 9router's account fallback never sees them.
export function throwIfAgentError(text) {
  if (typeof text !== "string") return;
  const trimmed = text.trim();
  const known = [
    { pattern: /^Insufficient balance\b/i, status: 402 },
    { pattern: /Daily free limit reached/i, status: 429 },
    { pattern: /^Error\s+(4\d\d|5\d\d):/i, status: null },
  ];
  for (const k of known) {
    const match = k.pattern.exec(trimmed);
    if (!match) continue;
    const error = new Error(trimmed);
    error.status = k.status || Number(match[1]);
    throw error;
  }
  if (!trimmed.startsWith("{")) return;
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch { return; }
  if (!parsed?.error || typeof parsed.error !== "object") return;
  const message = String(parsed.error.message || "Cline provider request failed");
  const statusMatch = /\b(?:Error\s+)?(4\d\d|5\d\d)\b/.exec(message);
  const error = new Error(message);
  error.status = statusMatch ? Number(statusMatch[1]) : 502;
  error.code = parsed.error.code;
  throw error;
}

// ─── OpenAI SSE synthesis ────────────────────────────────────────────────────

function completionId() {
  return `chatcmpl-${Date.now()}${Math.random().toString(36).slice(2, 10)}`;
}

function chunkFrame(meta, delta, finishReason = null) {
  return { ...meta, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

function sseResponse(stream) {
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── Executor ────────────────────────────────────────────────────────────────

export class ClineFreeExecutor extends BaseExecutor {
  constructor() {
    super(PROVIDER_ID, PROVIDERS[PROVIDER_ID] || { baseUrl: CLINE_INPROCESS_URL });
  }

  buildUrl() {
    return CLINE_INPROCESS_URL;
  }

  // Nothing leaves the process, so there is no wire auth to build.
  buildHeaders() {
    return {};
  }

  transformRequest() {
    return null;
  }

  /**
   * Drive one Cline turn. Returns the same shape every executor returns, with a
   * synthesized Response so the rest of the pipeline (translators, usage, SSE
   * plumbing) treats it like any HTTP provider.
   */
  async execute({ model, body, stream, signal, log }) {
    const b = body ?? {};
    const messages = Array.isArray(b.messages) ? b.messages : [];
    const prompt = buildPrompt(messages);
    if (!prompt.trim()) {
      return {
        response: jsonResponse(400, { error: { message: "No prompt/messages provided", type: "invalid_request_error" } }),
        url: CLINE_INPROCESS_URL, headers: {}, transformedBody: null,
      };
    }

    const { thinking, thinkingBudgetTokens } = normalizeThinkingForCline(b);
    const enableTools = clineToolsEnabled() && b.agent !== false;
    const cwd = resolveClineWorkspaceRoot();
    const maxTokensPerTurn = Number.isFinite(Number(b.max_tokens))
      ? clamp(Number(b.max_tokens), BUDGET_MIN, BUDGET_MAX)
      : undefined;
    const temperature = Number.isFinite(Number(b.temperature))
      ? Math.min(Math.max(Number(b.temperature), 0), 2)
      : undefined;

    const config = {
      providerId: CLINE_PROVIDER_ID,
      modelId: model,
      cwd,
      mode: b.mode === "plan" ? "plan" : "act",
      enableTools,
      enableSpawnAgent: false,
      enableAgentTeams: false,
      systemPrompt: buildSystemPrompt(b),
    };
    if (temperature !== undefined) config.temperature = temperature;
    if (thinking !== undefined) config.thinking = thinking;
    if (thinkingBudgetTokens !== undefined) config.thinkingBudgetTokens = thinkingBudgetTokens;
    if (maxTokensPerTurn !== undefined) config.maxTokensPerTurn = maxTokensPerTurn;

    log?.info?.("CLINE", `in-process turn → model=${model}, tools=${enableTools}, cwd=${cwd}`);

    const meta = { id: completionId(), created: Math.floor(Date.now() / 1000), model };
    const summary = { model, cwd, enableTools, mode: config.mode, thinking, promptLength: prompt.length };

    if (!stream) {
      try {
        const text = await this.#runTurn({ config, prompt, signal, onText: null });
        return {
          response: jsonResponse(200, {
            ...meta,
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
            usage: null,
          }),
          url: CLINE_INPROCESS_URL, headers: {}, transformedBody: summary,
        };
      } catch (error) {
        return {
          response: jsonResponse(error?.status && error.status >= 400 && error.status <= 599 ? error.status : 500, {
            error: { message: String(error?.message || error), type: "agent_error" },
          }),
          url: CLINE_INPROCESS_URL, headers: {}, transformedBody: summary,
        };
      }
    }

    const runTurn = (args) => this.#runTurn(args);
    const sseStream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        const send = (obj) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        // Clients expect the role on the first frame; Cline never sends one.
        send(chunkFrame(meta, { role: "assistant" }));
        try {
          await runTurn({
            config,
            prompt,
            signal,
            onText: (t) => send(chunkFrame(meta, { content: t })),
          });
          send(chunkFrame(meta, {}, "stop"));
        } catch (error) {
          // Already past HTTP 200 — report in-band, the way the rest of the
          // engine surfaces mid-stream failures.
          send({ ...chunkFrame(meta, {}, "error"), error: { message: String(error?.message || error), type: "agent_error" } });
        }
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    return { response: sseResponse(sseStream), url: CLINE_INPROCESS_URL, headers: {}, transformedBody: summary };
  }

  // One ClineCore lifecycle: create → subscribe → start → dispose.
  async #runTurn({ config, prompt, signal, onText }) {
    const ClineCore = await loadClineCore();
    await seedClineAuth();

    const sessionId = `9router_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const cline = await ClineCore.create({ clientName: "9router", backendMode: "local" });

    const onAbort = () => {
      Promise.allSettled([
        cline.abort(sessionId, signal?.reason || "request cancelled"),
        cline.stop(sessionId),
      ]).catch(() => {});
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });

    let doneText = null;
    const unsub = cline.subscribe?.((ev) => {
      try {
        if (ev?.type !== "chunk" || ev.payload?.stream !== "agent") return;
        const chunk = ev.payload?.chunk;
        if (typeof chunk !== "string" || !chunk.length) return;
        const done = envDoneText(chunk);
        if (done != null) doneText = done;
        const delta = envDelta(chunk);
        if (delta != null) onText?.(delta);
      } catch { /* a malformed envelope must not kill the turn */ }
    });

    try {
      const result = await cline.start({ config: { ...config, sessionId }, prompt, interactive: false });
      let text = result?.result?.text ?? "";
      // Some models return the raw envelope stream in result.text; fall back to
      // the terminal `done` frame's clean text.
      if (typeof text === "string" && text.trimStart().startsWith("{") && doneText != null) text = doneText;
      throwIfAgentError(text);
      return text;
    } finally {
      signal?.removeEventListener?.("abort", onAbort);
      unsub?.();
      try {
        await Promise.race([
          cline.dispose(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Cline cleanup timed out")), DISPOSE_TIMEOUT_MS).unref?.()),
        ]);
      } catch { /* a stuck dispose must not fail an otherwise good turn */ }
    }
  }
}

export default ClineFreeExecutor;
