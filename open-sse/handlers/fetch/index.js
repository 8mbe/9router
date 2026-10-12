// Web Fetch handler — dispatches to registered web extraction providers
// Returns normalized shape across all providers

import { buildTregHeaders } from "../treg/client.js";

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_FORMAT = "markdown";

/**
 * @typedef {Object} FetchResult
 * @property {boolean} success
 * @property {number} [status]
 * @property {string} [error]
 * @property {Object} [data]
 */

/**
 * Fetch with timeout abort.
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} timeoutMs
 */
// Strip non-ASCII chars from header values (HTTP headers must be ByteString).
function sanitizeHeaders(headers) {
  if (!headers) return headers;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = typeof v === "string" ? v.replace(/[^\x00-\xFF]/g, "").trim() : v;
  }
  return out;
}

async function tryFetch(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, headers: sanitizeHeaders(init.headers), signal: ctrl.signal });
    return { ok: true, res };
  } catch (err) {
    const isAbort = err?.name === "AbortError";
    return { ok: false, timeout: isAbort, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function truncate(text, max) {
  if (!text || typeof text !== "string") return text || "";
  if (!max || max <= 0) return text;
  return text.length > max ? text.slice(0, max) : text;
}

function parseJinaTitle(text) {
  const source = String(text || "");
  const metadataTitle = source.match(/^\s*Title:\s*(.+)$/mi);
  if (metadataTitle) return metadataTitle[1].trim();
  const m = source.match(/^\s*#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function buildData({ provider, url, title, format, text, links, costUsd, responseMs, upstreamMs }) {
  const data = {
    provider,
    url,
    title: title || null,
    content: { format, text: text || "", length: (text || "").length },
    metadata: { author: null, published_at: null, language: null },
    usage: { fetch_cost_usd: costUsd ?? null },
    metrics: { response_time_ms: responseMs, upstream_latency_ms: upstreamMs }
  };
  if (Array.isArray(links)) data.links = links;
  return data;
}

async function readJsonOrText(res) {
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    try { return { json: await res.json() }; } catch { return { text: "" }; }
  }
  return { text: await res.text() };
}

/**
 * Main handler.
 * @param {Object} params
 * @param {string} params.url
 * @param {string} [params.format]
 * @param {number} [params.maxCharacters]
 * @param {string} params.provider
 * @param {Object} [params.providerConfig]
 * @param {Object} [params.credentials]
 * @param {Function} [params.log]
 * @returns {Promise<FetchResult>}
 */
export async function handleFetchCore({ url, format, maxCharacters, provider, providerConfig, credentials, log }) {
  if (!url || typeof url !== "string") {
    return { success: false, status: 400, error: "url is required" };
  }
  if (!provider) {
    return { success: false, status: 400, error: "provider is required" };
  }

  const fmt = format || DEFAULT_FORMAT;
  const timeoutMs = providerConfig?.timeoutMs || DEFAULT_TIMEOUT_MS;
  const apiKey = credentials?.apiKey || credentials?.key || credentials?.token || "";
  const costPerQuery = providerConfig?.costPerQuery ?? null;
  const startedAt = Date.now();

  try {
    if (provider === "firecrawl") {
      return await runFirecrawl({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt });
    }
    if (provider === "jina-reader") {
      return await runJina({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt });
    }
    if (provider === "tavily") {
      return await runTavily({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt });
    }
    if (provider === "exa") {
      return await runExa({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt });
    }
    if (provider === "ollama") {
      return await runOllama({
        url,
        fmt,
        timeoutMs,
        apiKey,
        maxCharacters,
        costPerQuery,
        startedAt,
        baseUrl: providerConfig?.baseUrl,
      });
    }
    if (provider === "tinyfish") {
      return await runTinyfish({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt, baseUrl: providerConfig?.baseUrl });
    }
    if (provider === "treg") {
      return await runTreg({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt,
        baseUrl: providerConfig?.baseUrl, providerSpecificData: credentials?.providerSpecificData });
    }
    return { success: false, status: 400, error: `Unsupported provider: ${provider}` };
  } catch (err) {
    log?.("fetch handler error:", err?.message || err);
    return { success: false, status: 502, error: err?.message || "Internal fetch error" };
  }
}

function tregError(payload, fallback) {
  const error = payload?.detail || payload?.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") return error.message || JSON.stringify(error);
  return fallback;
}

async function runTreg({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt, baseUrl, providerSpecificData }) {
  if (!["markdown", "text"].includes(fmt)) {
    return { success: false, status: 400, error: `Unsupported Treg format: ${fmt}` };
  }
  if (!apiKey) return { success: false, status: 401, error: "No credentials for provider: treg" };
  const upstreamStart = Date.now();
  const r = await tryFetch(baseUrl, {
    method: "POST",
    headers: buildTregHeaders({ apiKey, providerSpecificData }),
    body: JSON.stringify({ url }),
    redirect: "error",
  }, timeoutMs);
  if (!r.ok) return { success: false, status: r.timeout ? 504 : 502, error: r.error };
  const upstreamMs = Date.now() - upstreamStart;
  const { json, text: errorText } = await readJsonOrText(r.res);
  if (!r.res.ok) {
    return { success: false, status: r.res.status, error: tregError(json, errorText?.slice(0, 500) || `Treg error: ${r.res.status}`) };
  }
  if (json?.detail || json?.error) {
    return { success: false, status: 502, error: tregError(json, "Treg fetch failed") };
  }
  if (r.res.status === 202 || json?._treg?.outcome === "pending") {
    return { success: false, status: 502, error: "Treg web extraction is still pending" };
  }
  const output = json?.output ?? json;
  const page = output?.pages?.[0];
  if (!Array.isArray(output?.pages) || !page || typeof page !== "object" || Array.isArray(page)) {
    return { success: false, status: 502, error: "Treg returned no extractable page content" };
  }
  if (page.error || page.success === false || page.ok === false || Number(page.status_code ?? page.status) >= 400) {
    return { success: false, status: 502, error: tregError(page, page.reason || "Treg page extraction failed") };
  }
  const metadata = page.metadata || {};
  const markdown = typeof page.markdown === "string" ? page.markdown
    : page.markdown?.raw_markdown ?? page.markdown?.fit_markdown ?? page.content?.markdown;
  const plain = typeof page.text === "string" ? page.text
    : typeof page.raw_content === "string" ? page.raw_content
    : typeof page.content === "string" ? page.content
    : typeof page.content?.text === "string" ? page.content.text
    : Array.isArray(page.excerpts) ? page.excerpts.filter((part) => typeof part === "string").join("\n\n")
    : undefined;
  const useMarkdown = typeof markdown === "string" && markdown.length > 0
    && (fmt === "markdown" || typeof plain !== "string" || plain.length === 0);
  const content = useMarkdown ? markdown : plain;
  if (typeof content !== "string" || content.length === 0) {
    return { success: false, status: 502, error: "Treg returned no extractable page content" };
  }
  const text = truncate(content, maxCharacters);
  const chargedMicro = json?._treg?.charged_micro ?? Number(r.res.headers.get("X-Treg-Cost-Micro") ?? NaN);
  const costUsd = Number.isFinite(chargedMicro) && chargedMicro >= 0 ? chargedMicro / 1_000_000 : costPerQuery;
  const nativeFormat = page.content?.format || page.format;
  const actualFormat = useMarkdown ? "markdown" : ["markdown", "text", "html"].includes(nativeFormat) ? nativeFormat : "text";
  return {
    success: true,
    data: {
      ...buildData({ provider: "treg", url, title: page.title || metadata.title,
        format: actualFormat, text, links: page.links,
        costUsd, responseMs: Date.now() - startedAt, upstreamMs }),
      metadata: { author: page.author || metadata.author || null,
        published_at: page.published_at || page.published_date || metadata.published_at || metadata.published_date || null,
        language: page.language || metadata.language || null },
    },
  };
}

async function runTinyfish({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt, baseUrl }) {
  if (!["markdown", "html"].includes(fmt)) return { success: false, status: 400, error: `Unsupported TinyFish format: ${fmt}` };
  const upstreamStart = Date.now();
  const r = await tryFetch(baseUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify({ urls: [url], format: fmt }),
  }, timeoutMs);
  if (!r.ok) return { success: false, status: r.timeout ? 504 : 502, error: r.error };
  const upstreamMs = Date.now() - upstreamStart;
  const { json } = await readJsonOrText(r.res);
  if (!r.res.ok) return { success: false, status: r.res.status, error: json?.error?.message || `TinyFish error: ${r.res.status}` };
  const failure = json?.errors?.[0];
  if (failure) return { success: false, status: failure.status || 502, error: `TinyFish fetch failed: ${failure.error || "unknown error"}` };
  const page = json?.results?.[0];
  if (!page || typeof page.text !== "string") return { success: false, status: 502, error: "TinyFish returned no extractable content" };
  const text = truncate(page.text, maxCharacters);
  return {
    success: true,
    data: {
      ...buildData({ provider: "tinyfish", url, title: page.title, format: fmt, text, links: page.links,
        costUsd: costPerQuery, responseMs: Date.now() - startedAt, upstreamMs }),
      metadata: { author: page.author || null, published_at: page.published_date || null, language: page.language || null },
    },
  };
}

async function runFirecrawl({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt }) {
  const upstreamStart = Date.now();
  const r = await tryFetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({ url, formats: [fmt] })
  }, timeoutMs);

  if (!r.ok) {
    return { success: false, status: r.timeout ? 504 : 502, error: r.error };
  }
  const upstreamMs = Date.now() - upstreamStart;
  const { json } = await readJsonOrText(r.res);
  if (!r.res.ok) {
    return { success: false, status: r.res.status, error: json?.error || `Firecrawl error: ${r.res.status}` };
  }
  const d = json?.data || {};
  const text = truncate(d.markdown || d.html || d.text || "", maxCharacters);
  const title = d.metadata?.title || null;
  return {
    success: true,
    data: buildData({
      provider: "firecrawl", url, title, format: fmt, text,
      costUsd: costPerQuery, responseMs: Date.now() - startedAt, upstreamMs
    })
  };
}

async function runJina({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt }) {
  const upstreamStart = Date.now();
  const r = await tryFetch("https://r.jina.ai/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({ url })
  }, timeoutMs);

  if (!r.ok) {
    return { success: false, status: r.timeout ? 504 : 502, error: r.error };
  }
  const upstreamMs = Date.now() - upstreamStart;
  const body = await r.res.text();
  if (!r.res.ok) {
    return { success: false, status: r.res.status, error: body?.slice(0, 500) || `Jina error: ${r.res.status}` };
  }
  const text = truncate(body, maxCharacters);
  return {
    success: true,
    data: buildData({
      provider: "jina-reader", url, title: parseJinaTitle(body), format: fmt, text,
      costUsd: costPerQuery, responseMs: Date.now() - startedAt, upstreamMs
    })
  };
}

async function runTavily({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt }) {
  const upstreamStart = Date.now();
  const r = await tryFetch("https://api.tavily.com/extract", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({ urls: [url], extract_depth: "basic" })
  }, timeoutMs);

  if (!r.ok) {
    return { success: false, status: r.timeout ? 504 : 502, error: r.error };
  }
  const upstreamMs = Date.now() - upstreamStart;
  const { json } = await readJsonOrText(r.res);
  if (!r.res.ok) {
    return { success: false, status: r.res.status, error: json?.error || `Tavily error: ${r.res.status}` };
  }
  const first = json?.results?.[0] || {};
  const text = truncate(first.raw_content || "", maxCharacters);
  return {
    success: true,
    data: buildData({
      provider: "tavily", url, title: null, format: fmt, text,
      costUsd: costPerQuery, responseMs: Date.now() - startedAt, upstreamMs
    })
  };
}

async function runExa({ url, fmt, timeoutMs, apiKey, maxCharacters, costPerQuery, startedAt }) {
  const upstreamStart = Date.now();
  const r = await tryFetch("https://api.exa.ai/contents", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { "x-api-key": apiKey } : {})
    },
    body: JSON.stringify({ ids: [url], text: true })
  }, timeoutMs);

  if (!r.ok) {
    return { success: false, status: r.timeout ? 504 : 502, error: r.error };
  }
  const upstreamMs = Date.now() - upstreamStart;
  const { json } = await readJsonOrText(r.res);
  if (!r.res.ok) {
    return { success: false, status: r.res.status, error: json?.error || `Exa error: ${r.res.status}` };
  }
  const first = json?.results?.[0] || {};
  const text = truncate(first.text || "", maxCharacters);
  return {
    success: true,
    data: buildData({
      provider: "exa", url, title: first.title || null, format: fmt, text,
      costUsd: costPerQuery, responseMs: Date.now() - startedAt, upstreamMs
    })
  };
}

async function runOllama({
  url,
  fmt,
  timeoutMs,
  apiKey,
  maxCharacters,
  costPerQuery,
  startedAt,
  baseUrl,
}) {
  const upstreamStart = Date.now();
  const r = await tryFetch(baseUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({ url })
  }, timeoutMs);

  if (!r.ok) {
    return { success: false, status: r.timeout ? 504 : 502, error: r.error };
  }
  const upstreamMs = Date.now() - upstreamStart;
  const { json, text: responseText } = await readJsonOrText(r.res);
  if (!r.res.ok) {
    const error = json?.error
      || json?.message
      || responseText?.slice(0, 500)
      || `Ollama error: ${r.res.status}`;
    return { success: false, status: r.res.status, error };
  }
  if (!json || typeof json.content !== "string") {
    return { success: false, status: 502, error: "Ollama returned an empty or invalid web fetch response" };
  }

  const text = truncate(json.content, maxCharacters);
  return {
    success: true,
    data: buildData({
      provider: "ollama",
      url,
      title: json.title || null,
      format: fmt,
      text,
      links: json.links,
      costUsd: costPerQuery,
      responseMs: Date.now() - startedAt,
      upstreamMs
    })
  };
}
