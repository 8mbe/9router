import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { isAnthropicCompatibleProvider } from "@/shared/constants/providers";
import { extractContextLength } from "./contextLength";

const DEFAULT_TIMEOUT_MS = 20000;

// Matches the /api/models/test probe: a reasoning model can spend its whole budget
// on chain-of-thought before answering, so a 16-token probe reads as a failure.
const PROBE_MAX_TOKENS = 1024;

async function probeFetch(url, options, effectiveProxy) {
  if (!options.signal) options.signal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
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
 * Send one real completion to `modelId` using this connection's own credentials.
 *
 * Deliberately bypasses /v1/chat/completions: the router's account fallback would
 * silently retry on another connection, so a green result would not tell you which
 * key actually works. A key that is valid for one model and rejected for another is
 * exactly what this has to distinguish, so the request goes straight to the
 * connection's base URL with that connection's key.
 */
export async function probeConnectionModel(connection, modelId, options = {}) {
  const start = Date.now();
  const baseUrl = connection?.providerSpecificData?.baseUrl;
  if (!baseUrl) {
    return { ok: false, error: "Connection has no base URL", latencyMs: 0, status: null };
  }
  if (!modelId) {
    return { ok: false, error: "No model id", latencyMs: 0, status: null };
  }

  const effectiveProxy = options.proxy !== undefined
    ? options.proxy
    : await resolveConnectionProxyConfig(connection.providerSpecificData || {});

  const isAnthropic = isAnthropicCompatibleProvider(connection.provider);
  const apiKey = connection.apiKey || connection.accessToken || "";

  try {
    let res;
    if (isAnthropic) {
      res = await probeFetch(anthropicMessagesUrl(baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: PROBE_MAX_TOKENS,
          messages: [{ role: "user", content: "hi" }],
        }),
        signal: options.signal,
      }, effectiveProxy);
    } else {
      res = await probeFetch(`${normalizeBase(baseUrl)}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: PROBE_MAX_TOKENS,
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        }),
        signal: options.signal,
      }, effectiveProxy);
    }

    const latencyMs = Date.now() - start;
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
      latencyMs,
    };
  } catch (error) {
    const latencyMs = Date.now() - start;
    const aborted = error?.name === "AbortError" || error?.name === "TimeoutError";
    return {
      ok: false,
      error: aborted ? `Timed out after ${DEFAULT_TIMEOUT_MS}ms` : (error?.message || "Network error"),
      status: null,
      latencyMs,
    };
  }
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
    const res = await probeFetch(`${base}/models`, { method: "GET", headers }, effectiveProxy);
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
