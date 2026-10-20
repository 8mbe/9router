import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { fetchCustomApiDiagnostic } from "@/lib/network/customApi";
import { isCustomApiProvider } from "open-sse/utils/customApiPrivacy.js";
import { isAnthropicCompatibleProvider } from "@/shared/constants/providers";
import { CLAUDE_CODE } from "open-sse/config/claudeCodeConstants.js";
import { TREG_CONFIG, TREG_ROUTES, TREG_CATALOG_PLATFORMS } from "open-sse/config/treg.js";
import { buildTregHeaders } from "open-sse/handlers/treg/client.js";
import { extractContextLength } from "./contextLength";
import { consumeProbeStream, createStreamMetrics, ESSAY_PROMPT, ESSAY_TIMEOUT_MS, PING_PROMPT } from "./streamMetrics";

const DEFAULT_TIMEOUT_MS = 20000;

// Matches the /api/models/test probe: a reasoning model can spend its whole budget
// on chain-of-thought before answering, so a 16-token probe reads as a failure.
const PROBE_MAX_TOKENS = 1024;

// Socket-level drops that mean "the pooled keep-alive connection was already dead",
// not "the upstream rejected us". undici never retries a POST on its own, so without
// this a probe that lands on a stale socket fails in a few ms without reaching the
// upstream. Refused/DNS errors are left out on purpose: retrying those only hides them.
const TRANSIENT_SOCKET_CODES = new Set(["UND_ERR_SOCKET", "UND_ERR_CLOSED", "ECONNRESET", "EPIPE"]);

function isTransientSocketError(error) {
  const code = error?.cause?.code || error?.code;
  return TRANSIENT_SOCKET_CODES.has(code);
}

/** `fetch failed` alone says nothing; the reason lives on `error.cause`. */
function describeFetchError(error) {
  const message = error?.message || "Network error";
  const cause = error?.cause;
  if (!cause) return message;
  const detail = [cause.code, cause.message].filter(Boolean).join(": ");
  return detail && detail !== message ? `${message} (${detail})` : message;
}

async function probeFetch(url, options, effectiveProxy, connection = null, diagnosticOptions) {
  if (!options.signal) options.signal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  try {
    return await probeFetchOnce(url, options, effectiveProxy, connection, diagnosticOptions);
  } catch (error) {
    if (options.signal.aborted || !isTransientSocketError(error)) throw error;
    // One retry opens a fresh connection; the shared signal keeps the overall deadline.
    return probeFetchOnce(url, options, effectiveProxy, connection, diagnosticOptions);
  }
}

async function probeFetchOnce(url, options, effectiveProxy, connection, diagnosticOptions) {
  if (connection && isCustomApiProvider(connection.provider)) {
    return fetchCustomApiDiagnostic(connection, url, options, effectiveProxy, diagnosticOptions);
  }
  if (effectiveProxy?.vercelRelayUrl) {
    const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");
    return proxyAwareFetch(url, options, { vercelRelayUrl: effectiveProxy.vercelRelayUrl });
  }
  if (!effectiveProxy?.connectionProxyEnabled || !effectiveProxy?.connectionProxyUrl) {
    return fetch(url, options);
  }
  const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");
  return proxyAwareFetch(url, options, {
    connectionProxyEnabled: true,
    connectionProxyUrl: effectiveProxy.connectionProxyUrl,
    connectionNoProxy: effectiveProxy.connectionNoProxy || "",
  });
}

function normalizeBase(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "");
}

/** Anthropic base URLs are stored either bare or already pointing at /messages. */
function anthropicMessagesUrl(baseUrl) {
  let base = normalizeBase(baseUrl);
  if (base.endsWith("/messages")) return base;
  if (base.endsWith("/v1")) return `${base}/messages`;
  return `${base}/v1/messages`;
}

function shortError(value, fallback) {
  const text = typeof value === "string" ? value : value ? JSON.stringify(value) : "";
  const trimmed = text.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, 240);
}

function parseBody(rawText) {
  if (!rawText) return null;
  try { return JSON.parse(rawText); } catch { return null; }
}

/**
 * Classify an OpenAI-shaped completion. Kept aligned with
 * src/app/api/models/test/ping.js so a model reads the same either way.
 */
function classifyOpenAI(res, parsed, rawText) {
  if (!res.ok) {
    const detail = parsed?.error?.message || parsed?.msg || parsed?.message || parsed?.error || rawText;
    return { ok: false, error: `HTTP ${res.status}${detail ? `: ${shortError(detail, "")}` : ""}` };
  }

  // Some gateways answer 200 with an error envelope rather than an HTTP error.
  const providerStatus = parsed?.status;
  const providerMsg = parsed?.msg || parsed?.message;
  const hasProviderErrorStatus = providerStatus !== undefined
    && providerStatus !== null
    && String(providerStatus) !== "200"
    && String(providerStatus) !== "0";
  if (hasProviderErrorStatus && providerMsg) {
    return { ok: false, error: `Provider status ${providerStatus}: ${shortError(providerMsg, "")}` };
  }
  if (parsed?.error) {
    return { ok: false, error: shortError(parsed.error?.message || parsed.error, "Provider returned an error") };
  }

  const choices = Array.isArray(parsed?.choices) ? parsed.choices : [];
  if (choices.length === 0) {
    return { ok: false, error: "Provider returned no completion choices for this model" };
  }

  const message = choices[0]?.message || {};
  const hasReasoning = Boolean(
    message.reasoning || message.reasoning_content || message.thinking || message.thinking_content
  );
  const contentEmpty = !String(message.content || "").trim();
  if (choices[0]?.finish_reason === "length" && contentEmpty && hasReasoning) {
    return { ok: true, note: "reasoning-only response (length-limited)" };
  }
  return { ok: true };
}

function classifyAnthropic(res, parsed, rawText) {
  if (!res.ok) {
    const detail = parsed?.error?.message || parsed?.error || rawText;
    return { ok: false, error: `HTTP ${res.status}${detail ? `: ${shortError(detail, "")}` : ""}` };
  }
  const content = Array.isArray(parsed?.content) ? parsed.content : [];
  if (content.length === 0 && parsed?.stop_reason !== "max_tokens") {
    return { ok: false, error: "Provider returned no content blocks for this model" };
  }
  return { ok: true };
}

/**
 * Resolve the completion URL for a probe. Base URLs arrive in both shapes: a saved
 * compatible node stores the bare root, while PROVIDERS transports store the full
 * endpoint — appending blindly would produce /chat/completions/chat/completions.
 */
function completionUrl(baseUrl, format) {
  const base = normalizeBase(baseUrl);
  if (format === "claude") return anthropicMessagesUrl(base);
  if (base.endsWith("/chat/completions")) return base;
  return `${base}/chat/completions`;
}

async function probeTregModel(connection, modelId, options = {}) {
  const start = Date.now();
  const result = (ok, error, status, note = null) => ({
    ok, error, status, note, latencyMs: Date.now() - start,
    ...(options.testType ? { testType: options.testType } : {}),
  });
  if (options.testType === "essay") return {
    ...result(false, "Essay tests require a chat model", 400),
    ...createStreamMetrics({ startTime: start }).snapshot(),
  };
  const route = Object.hasOwn(TREG_ROUTES, modelId) ? TREG_ROUTES[modelId] : null;
  if (!route) return result(false, `Unsupported Treg model: ${modelId}`, 400);
  if (options.kind && options.kind !== route.kind) {
    return result(false, `Treg model '${modelId}' does not support ${options.kind}`, 400);
  }

  try {
    const headers = buildTregHeaders(connection);
    const effectiveProxy = options.proxy !== undefined
      ? options.proxy
      : await resolveConnectionProxyConfig(connection.providerSpecificData || {});
    const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const auth = await probeFetch(TREG_CONFIG.validateUrl, {
      method: "GET", headers, signal, redirect: "error",
    }, effectiveProxy);
    if (!auth.ok) {
      return result(false, auth.status === 401 || auth.status === 403
        ? "Invalid Treg API token"
        : `Treg authentication returned HTTP ${auth.status}`, auth.status);
    }
    await auth.body?.cancel?.();

    // Catalog metadata is public; keep credentials on the identity request only.
    const catalog = await probeFetch(`${TREG_CONFIG.baseUrl}/catalog/endpoints/${encodeURIComponent(modelId)}`, {
      method: "GET", headers: { Accept: "application/json" }, signal, redirect: "error",
    }, effectiveProxy);
    if (!catalog.ok) return result(false, `Treg catalog returned HTTP ${catalog.status}`, catalog.status);
    const metadata = await catalog.json().catch(() => null);
    const endpoint = metadata?.endpoint;
    if (endpoint?.id !== modelId || endpoint.platform !== TREG_CATALOG_PLATFORMS[route.kind]) {
      return result(false, `Treg catalog does not confirm the ${route.kind} endpoint '${modelId}'`, 502);
    }
    return result(true, null, catalog.status, "Token and catalog endpoint verified; generation was not run");
  } catch (error) {
    const aborted = error?.name === "AbortError" || error?.name === "TimeoutError";
    return result(false, aborted ? `Timed out after ${DEFAULT_TIMEOUT_MS}ms` : describeFetchError(error), error?.statusCode ?? null);
  }
}

/**
 * Send one real completion to `model` at an explicit endpoint.
 *
 * Shared by the saved-connection probe and the pre-save "Check Model" button on the
 * add-key modal, so a model gets the same verdict before and after it is stored.
 * `format` is the transport format ("openai" | "claude"); anything else is the
 * caller's job to map first.
 */
export async function probeModelEndpoint({
  baseUrl,
  apiKey = "",
  model,
  format = "openai",
  provider,
  providerSpecificData,
  connectionId,
  headers: extraHeaders,
  authHeader,
  proxy,
  signal,
  kind,
  testType,
}) {
  if (provider === "treg") {
    return probeTregModel({ provider, apiKey, providerSpecificData }, model, { proxy, signal, kind, testType });
  }
  const start = Date.now();
  const essay = testType === "essay";
  const metrics = essay ? createStreamMetrics({ startTime: start }) : null;
  const extra = () => ({ ...(testType ? { testType } : {}), ...metrics?.snapshot() });
  if (!baseUrl) return { ok: false, error: "No base URL", latencyMs: 0, status: null, ...extra() };
  if (!model) return { ok: false, error: "No model id", latencyMs: 0, status: null, ...extra() };

  const timeoutMs = essay ? ESSAY_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  const deadline = AbortSignal.timeout(timeoutMs);
  const probeSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const prompt = essay ? ESSAY_PROMPT : testType === "ping" ? PING_PROMPT : "hi";
  const maxTokens = essay ? 2048 : PROBE_MAX_TOKENS;

  const isAnthropic = format === "claude";
  const url = completionUrl(baseUrl, format);
  const connection = { provider, apiKey, connectionId, providerSpecificData: { ...providerSpecificData, baseUrl } };

  try {
    let res;
    let native = false;
    if (isAnthropic && isAnthropicCompatibleProvider(provider) && providerSpecificData?.executionMode === CLAUDE_CODE.executionMode
      && providerSpecificData?.anonymizeRequests !== true && providerSpecificData?.customApiSessionPinning !== true) {
      const { probeClaudeCodeModel } = await import("./claudeCode");
      native = true;
      res = await probeClaudeCodeModel({
        baseUrl, apiKey, model, authMode: providerSpecificData.authMode || "api-key",
        proxy, signal: probeSignal, maxTokens, timeoutMs, prompt, onEvent: metrics?.add,
      });
    } else if (isAnthropic) {
      res = await probeFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(extraHeaders || {}),
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          ...(essay ? { stream: true } : {}),
          messages: [{ role: "user", content: prompt }],
        }),
        signal: probeSignal,
      }, proxy, connection, { streamResponse: essay });
    } else {
      const headers = { "Content-Type": "application/json", ...(extraHeaders || {}) };
      if (apiKey) {
        if (authHeader === "x-api-key") headers["X-API-Key"] = apiKey;
        else headers["Authorization"] = `Bearer ${apiKey}`;
      }
      res = await probeFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          stream: essay,
          ...(essay ? { stream_options: { include_usage: true } } : {}),
          messages: [{ role: "user", content: prompt }],
        }),
        signal: probeSignal,
      }, proxy, connection, { streamResponse: essay });
    }

    if (essay && !native) {
      const result = await consumeProbeStream(res, { startTime: start, signal: probeSignal });
      return { ...result, testType, status: res.status, latencyMs: Date.now() - start };
    }
    const rawText = await res.text().catch(() => "");
    const parsed = parseBody(rawText);
    const verdict = isAnthropic
      ? classifyAnthropic(res, parsed, rawText)
      : classifyOpenAI(res, parsed, rawText);

    return {
      ok: verdict.ok,
      error: verdict.ok ? null : verdict.error,
      note: verdict.note || null,
      status: res.status,
      latencyMs: Date.now() - start,
      ...extra(),
      ...(essay && native && verdict.ok ? metrics.result() : {}),
    };
  } catch (error) {
    const latencyMs = Date.now() - start;
    const aborted = error?.name === "AbortError" || error?.name === "TimeoutError";
    const timedOut = error?.name === "TimeoutError" || probeSignal.reason?.name === "TimeoutError";
    return {
      ok: false,
      error: timedOut
        ? (deadline.aborted ? `Timed out after ${timeoutMs}ms` : "Model test timed out")
        : aborted ? "Model test cancelled" : describeFetchError(error),
      status: error?.statusCode ?? null,
      latencyMs,
      ...extra(),
    };
  }
}

/**
 * Send one real completion to `modelId` using this connection's own credentials.
 *
 * Deliberately bypasses /v1/chat/completions: the router's account fallback would
 * silently retry on another connection, so a green result would not tell you which
 * key actually works. A key that is valid for one model and rejected for another is
 * exactly what this has to distinguish, so the request goes straight to the
 * connection's base URL with that connection's key.
 */
export async function probeConnectionModel(connection, modelId, options = {}) {
  if (connection?.provider === "treg") return probeTregModel(connection, modelId, options);
  const baseUrl = connection?.providerSpecificData?.baseUrl;
  if (!baseUrl) {
    return {
      ok: false, error: "Connection has no base URL", latencyMs: 0, status: null,
      ...(options.testType ? { testType: options.testType } : {}),
      ...(options.testType === "essay" ? createStreamMetrics().snapshot() : {}),
    };
  }

  const effectiveProxy = options.proxy !== undefined
    ? options.proxy
    : await resolveConnectionProxyConfig(connection.providerSpecificData || {});

  return probeModelEndpoint({
    baseUrl,
    apiKey: connection.apiKey || connection.accessToken || "",
    model: modelId,
    format: isAnthropicCompatibleProvider(connection.provider) ? "claude" : "openai",
    provider: connection.provider,
    connectionId: connection.id,
    providerSpecificData: connection.providerSpecificData,
    proxy: effectiveProxy,
    signal: options.signal,
    testType: options.testType,
  });
}

/**
 * Read the connection's /models once and return `{ [modelId]: contextLength }` for
 * every entry that advertises one. Failures are non-fatal — context is a nice-to-have
 * next to the pass/fail result, so a gateway without /models just yields nothing.
 */
export async function fetchModelContextLengths(connection, options = {}) {
  const baseUrl = connection?.providerSpecificData?.baseUrl;
  if (!baseUrl) return {};

  const effectiveProxy = options.proxy !== undefined
    ? options.proxy
    : await resolveConnectionProxyConfig(connection.providerSpecificData || {});

  const isAnthropic = isAnthropicCompatibleProvider(connection.provider);
  const apiKey = connection.apiKey || connection.accessToken || "";
  let base = normalizeBase(baseUrl);
  if (isAnthropic && base.endsWith("/messages")) base = base.slice(0, -"/messages".length);

  const headers = isAnthropic
    ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Authorization": `Bearer ${apiKey}` }
    : { "Authorization": `Bearer ${apiKey}` };

  try {
    const res = await probeFetch(`${base}/models`, { method: "GET", headers }, effectiveProxy, connection);
    if (!res.ok) return {};
    const data = await res.json().catch(() => null);
    const list = Array.isArray(data) ? data : (data?.data || data?.models || data?.results || []);
    const out = {};
    for (const entry of list) {
      const id = entry?.id || entry?.name || entry?.model;
      if (!id) continue;
      const ctx = extractContextLength(entry);
      if (ctx !== null) out[id] = ctx;
    }
    return out;
  } catch {
    return {};
  }
}
