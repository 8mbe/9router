import { buildClineHeaders } from "../shared/clineAuth.js";

const CLINEPASS_MODELS_ENDPOINT = "https://api.cline.bot/api/v1/models";
// Cline's curated feed, and the authority on what the free plan covers: /models
// lists what the gateway can route but says nothing about who pays, and the
// `cline-free/*` ids are not even in it. Without this call the free tier looks
// emptier than it is.
const CLINE_RECOMMENDED_ENDPOINT = "https://api.cline.bot/api/v1/ai/cline/recommended-models";
const FETCH_TIMEOUT_MS = 5000;

/**
 * Build request headers for the ClinePass /models endpoint (Cline's upstream API).
 * - API keys are sent as plain Bearer tokens.
 * - OAuth access tokens must carry the WorkOS `workos:` prefix (handled by buildClineHeaders).
 */
function buildModelListHeaders(token, isApiKey) {
  if (isApiKey) {
    return {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    };
  }
  return buildClineHeaders(token, { Accept: "application/json" });
}

/**
 * Internal: fetch the raw model list from Cline's /models endpoint.
 * Returns the parsed array or null on any failure.
 */
async function fetchClineRawModels(credentials, endpoint = CLINEPASS_MODELS_ENDPOINT) {
  const isApiKey = Boolean(credentials?.apiKey);
  const token = isApiKey ? credentials.apiKey : credentials?.accessToken;
  if (!token) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const headers = buildModelListHeaders(token, isApiKey);

    const response = await fetch(endpoint, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const json = await response.json();
    // /models answers {data:[...]}, the recommended feed {recommended,free,...}.
    const rawList = Array.isArray(json) ? json : (json?.data ?? json?.free);
    return Array.isArray(rawList) ? rawList : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch ClinePass live model catalog from Cline's /models endpoint.
 * Returns only models with the cline-pass/ prefix.
 *
 * @param {object} credentials - Connection credentials ({ accessToken, apiKey })
 * @returns {Promise<{ models: { id: string, name: string }[] } | null>}
 */
export async function resolveClinepassModels(credentials) {
  const rawList = await fetchClineRawModels(credentials);
  if (!rawList) return null;

  const models = rawList
    .filter((m) => typeof m?.id === "string" && m.id.startsWith("cline-pass/"))
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
    }));

  return models.length ? { models } : null;
}

/**
 * Fetch Cline's live model catalog: everything /models routes, plus the
 * `cline-free/*` ids that only the recommended feed knows about. Unlike
 * resolveClinepassModels, nothing is filtered by prefix.
 *
 * @param {object} credentials - Connection credentials ({ accessToken, apiKey })
 * @returns {Promise<{ models: { id: string, name: string }[] } | null>}
 */
export async function resolveClineModels(credentials) {
  const [rawList, freeList] = await Promise.all([
    fetchClineRawModels(credentials),
    fetchClineRawModels(credentials, CLINE_RECOMMENDED_ENDPOINT),
  ]);
  if (!rawList && !freeList) return null;

  const models = [];
  const seen = new Set();
  // The feed's `free` array is Cline's own answer to "what is free on this
  // account" — it is taken whole, not filtered by id shape or by catalog price.
  // z-ai/glm-5.3-flash is the case that matters: Cline serves it free, while the
  // catalog quotes a per-token price for it.
  // Free first, too: /models is the long list, and burying the handful of free
  // ids at the end of 400+ paid ones is how they go unnoticed.
  const free = (freeList || []).filter((m) => typeof m?.id === "string");
  const freeIds = new Set(free.map((m) => m.id));
  // Everything else the gateway routes, minus the vendors' own `:free` ids: the
  // catalog is full of them and most only fail on the first request. The ones
  // Cline actually serves (poolside/laguna-s-2.1:free today) are in the feed
  // above, so they survive this.
  const paid = (rawList || []).filter((m) => !(typeof m?.id === "string" && m.id.endsWith(":free") && !freeIds.has(m.id)));
  const freeFirst = [...free, ...paid];
  for (const m of freeFirst) {
    if (typeof m?.id !== "string" || m.id.trim() === "" || seen.has(m.id)) continue;
    seen.add(m.id);
    models.push({ id: m.id, name: m.name || m.id });
  }

  return models.length ? { models } : null;
}
