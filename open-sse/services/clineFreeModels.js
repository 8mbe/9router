// Live catalog for the cline-free provider.
//
// cline-free stores no credential of its own — it rides the local `cline auth`
// session (shared/clineLocalAuth.js), so the model list is fetched with that
// token instead of a connection record.
//
// Two endpoints, because neither alone is the list Cline's own picker shows:
//   /api/v1/ai/cline/models            the full 400+ catalog WITH pricing; the
//                                      zero-priced entries are the `:free` tier.
//   /api/v1/ai/cline/recommended-models  the curated feed, and the only place the
//                                      `cline-free/*` ids (deepseek-v4.1-flash,
//                                      muse-spark, solar-pro4) appear at all.
// `/api/v1/models` (what clinepassModels.js uses) carries ids only — no pricing —
// so it cannot answer "which of these are free".
//
// Fail-open: any failure returns null and the caller falls back to the static
// catalog in providers/registry/cline-free.js.

import { buildClineHeaders } from "../shared/clineAuth.js";
import { readClineLocalToken } from "../shared/clineLocalAuth.js";

const CATALOG_ENDPOINT = "https://api.cline.bot/api/v1/ai/cline/models";
const RECOMMENDED_ENDPOINT = "https://api.cline.bot/api/v1/ai/cline/recommended-models";
const FETCH_TIMEOUT_MS = 8000;
// The catalog is ~500KB and changes on Cline's release cadence, not per request.
const CACHE_TTL_MS = 10 * 60 * 1000;

let cache = null; // { at: number, models: [] | null }

function isZeroPriced(model) {
  const pricing = model?.pricing;
  if (!pricing || typeof pricing !== "object") return false;
  const prompt = Number(pricing.prompt);
  const completion = Number(pricing.completion);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return false;
  return prompt === 0 && completion === 0;
}

// cline-free is an LLM provider: Lyria and friends are zero-priced too, but they
// emit audio (`["text","audio"]`) and would only ever fail a chat request.
function emitsTextOnly(model) {
  const out = model?.architecture?.output_modalities;
  if (!Array.isArray(out) || out.length === 0) return true;
  return out.every((modality) => modality === "text");
}

function normalize(model) {
  const id = typeof model?.id === "string" ? model.id.trim() : "";
  if (!id) return null;
  const entry = { id, name: model?.name || id };
  const context = Number(model?.context_length ?? model?.top_provider?.context_length);
  if (Number.isFinite(context) && context > 0) entry.contextLength = context;
  return entry;
}

async function fetchJson(url, token, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: buildClineHeaders(token, { Accept: "application/json" }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The `free` feed mixes genuinely free ids with discounted ones (z-ai/glm-5.3-flash
// is listed there but priced in the catalog), so only Cline's own free namespace
// is taken from it — everything else has to prove it costs nothing.
function freeTierFromFeed(feed) {
  const list = Array.isArray(feed?.free) ? feed.free : [];
  return list
    .filter((m) => typeof m?.id === "string" && m.id.startsWith("cline-free/"))
    .map((m) => ({ id: m.id, name: m.name || m.id }));
}

/**
 * Resolve the free models the logged-in Cline account can actually call.
 *
 * @param {object} [options]
 * @param {string} [options.token]      override the on-disk session token
 * @param {typeof fetch} [options.fetchImpl]
 * @param {boolean} [options.forceRefresh] bypass the TTL cache
 * @returns {Promise<{ models: { id: string, name: string, contextLength?: number }[] } | null>}
 */
export async function resolveClineFreeModels(options = {}) {
  const { forceRefresh = false, fetchImpl = fetch } = options;
  if (!forceRefresh && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.models?.length ? { models: cache.models } : null;
  }

  const token = options.token || (await readClineLocalToken());
  if (!token) {
    cache = { at: Date.now(), models: null };
    return null;
  }

  const [catalog, feed] = await Promise.all([
    fetchJson(CATALOG_ENDPOINT, token, fetchImpl),
    fetchJson(RECOMMENDED_ENDPOINT, token, fetchImpl),
  ]);

  const rawList = Array.isArray(catalog) ? catalog : catalog?.data;
  const fromCatalog = Array.isArray(rawList)
    ? rawList.filter((m) => isZeroPriced(m) && emitsTextOnly(m)).map(normalize).filter(Boolean)
    : [];

  const models = [];
  const seen = new Set();
  for (const model of [...freeTierFromFeed(feed), ...fromCatalog]) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }

  cache = { at: Date.now(), models: models.length ? models : null };
  return models.length ? { models } : null;
}

// Tests drive the cache directly; production callers never need this.
export function resetClineFreeModelsCache() {
  cache = null;
}
