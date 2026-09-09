// Shared Cline model-catalog access for the `cline`, `clinepass` and `cline-free`
// providers. All three talk to the same upstream (api.cline.bot) with the same
// auth shapes, so the fetch + short-TTL cache lives here once and each provider
// service only supplies its own id filter.
import { buildClineHeaders } from "./clineAuth.js";

const CLINE_API_BASE = "https://api.cline.bot/api/v1";

/** Full catalog (paid + free). Readable with any valid Cline credential. */
export const CLINE_MODELS_ENDPOINT = `${CLINE_API_BASE}/models`;
/** Free-tier-only catalog. Auth-gated — 401 for anonymous callers. */
export const CLINE_FREE_MODELS_ENDPOINT = `${CLINE_API_BASE}/models/free`;

const FETCH_TIMEOUT_MS = 5000;
// Cline's catalog changes on the order of days; 5 min keeps /v1/models cheap
// without going stale for a whole session.
const CACHE_TTL_MS = 5 * 60 * 1000;

// Cline namespaces its own bundles by prefix (`cline-pass/`, `cline-free/`) and
// mirrors OpenRouter's `:free` suffix for zero-cost upstream models.
const CLINE_PASS_PREFIX = "cline-pass/";
const CLINE_FREE_PREFIX = "cline-free/";
const FREE_SUFFIX = ":free";

/** ClinePass bundle model (paid subscription tier). */
export function isClinePassModelId(id) {
  return typeof id === "string" && id.startsWith(CLINE_PASS_PREFIX);
}

/** Cline's own free bundle (`cline-free/*`), as opposed to an upstream `:free` model. */
export function isClineFreeBundleModelId(id) {
  return typeof id === "string" && id.startsWith(CLINE_FREE_PREFIX);
}

/** Zero-cost model — either Cline's own free bundle or an OpenRouter-style `:free` id. */
export function isClineFreeModelId(id) {
  if (typeof id !== "string") return false;
  return id.startsWith(CLINE_FREE_PREFIX) || id.endsWith(FREE_SUFFIX);
}

/**
 * Build headers for a Cline catalog request.
 * - API keys go out as plain Bearer tokens.
 * - OAuth access tokens need the WorkOS `workos:` prefix (buildClineHeaders adds it).
 */
export function buildClineCatalogHeaders(token, isApiKey) {
  if (isApiKey) {
    return { Accept: "application/json", Authorization: `Bearer ${token}` };
  }
  return buildClineHeaders(token, { Accept: "application/json" });
}

/** Pull the model array out of any of the shapes Cline's endpoints return. */
function extractModelList(json) {
  if (Array.isArray(json)) return json;
  for (const key of ["data", "models", "results"]) {
    if (Array.isArray(json?.[key])) return json[key];
  }
  return null;
}

// Raw-list cache keyed by endpoint + credential kind. The catalog is
// account-independent for these endpoints, so the kind ("key"/"oauth") is
// enough — raw tokens never become cache keys.
const cache = new Map();
const inFlight = new Map();

function cacheKey(endpoint, isApiKey) {
  return `${endpoint}|${isApiKey ? "key" : "oauth"}`;
}

async function fetchCatalogUncached(endpoint, token, isApiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: buildClineCatalogHeaders(token, isApiKey),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return extractModelList(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a Cline catalog endpoint, cached for CACHE_TTL_MS with in-flight dedup.
 * Failures are never cached, so a transient upstream blip doesn't stick.
 *
 * @param {string} endpoint - CLINE_MODELS_ENDPOINT or CLINE_FREE_MODELS_ENDPOINT
 * @param {object} credentials - { accessToken, apiKey }
 * @returns {Promise<object[]|null>} raw upstream entries, or null on failure
 */
export async function fetchClineCatalog(endpoint, credentials) {
  const isApiKey = Boolean(credentials?.apiKey);
  const token = isApiKey ? credentials.apiKey : credentials?.accessToken;
  if (!token) return null;

  const key = cacheKey(endpoint, isApiKey);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = fetchCatalogUncached(endpoint, token, isApiKey)
    .then((value) => {
      if (value?.length) cache.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, promise);
  return promise;
}

/** Normalize raw upstream entries to 9router's { id, name } shape, keeping only `predicate` matches. */
export function toModelEntries(rawList, predicate) {
  if (!Array.isArray(rawList)) return [];
  return rawList
    .filter((m) => typeof m?.id === "string" && predicate(m.id))
    .map((m) => ({ id: m.id, name: m.name || m.display_name || m.id }));
}

/** Test-only: drop cached catalogs so a test can control what the next fetch sees. */
export function __resetClineCatalogCache() {
  cache.clear();
  inFlight.clear();
}
