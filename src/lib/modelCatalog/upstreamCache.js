// In-memory cache for the *upstream* half of /v1/models.
//
// Building the models list is cheap except for one thing: every provider with a
// live catalog resolver (kiro, qoder, github, cursor, ...) and every
// OpenAI/Anthropic-compatible provider with no pinned model list costs a network
// round trip, each with a multi-second timeout. With a handful of those
// connected, /v1/models takes seconds — every time, for a catalog that changes
// maybe once a week.
//
// So only the network results are cached; everything DB-driven (aliases, custom
// models, disabled models, combos, enabledModels) is still read fresh on every
// request, and edits made in the dashboard show up immediately.
//
// Serving is stale-while-revalidate: once an entry exists, requests never wait
// on the network again — an expired entry is returned as-is and refreshed in the
// background. Concurrent misses share one in-flight promise.

const DEFAULT_TTL_MS = 5 * 60 * 1000;

function resolveTtl() {
  const raw = Number(process.env.MODELS_CACHE_TTL_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return DEFAULT_TTL_MS;
}

/** @type {Map<string, { value: any, expiresAt: number, inflight: Promise<any> | null }>} */
const cache = new Map();

/**
 * Resolve `key` through the cache, calling `loader` only when there is nothing
 * fresh to serve.
 *
 * A loader that throws or resolves to null/undefined never replaces a cached
 * value: upstream being briefly unreachable should not empty a provider's model
 * list, and a cold failure just returns null so the caller keeps its fallback.
 *
 * @param {string} key
 * @param {() => Promise<any>} loader
 * @returns {Promise<any|null>}
 */
export async function getCachedUpstream(key, loader) {
  const ttl = resolveTtl();
  const entry = cache.get(key);
  const now = Date.now();

  if (entry && entry.value != null) {
    if (now < entry.expiresAt) return entry.value;
    // Expired but usable: hand back the stale value and refresh behind it, so a
    // request never pays the upstream latency once the cache is warm.
    if (!entry.inflight) {
      entry.inflight = revalidate(key, loader, entry);
    }
    return entry.value;
  }

  // Cold (or previously failed): the caller has to wait, but concurrent callers
  // share the single in-flight load.
  if (entry?.inflight) return entry.inflight;

  const pending = { value: entry?.value ?? null, expiresAt: 0, inflight: null };
  cache.set(key, pending);
  pending.inflight = revalidate(key, loader, pending);
  return pending.inflight;
}

async function revalidate(key, loader, entry) {
  try {
    const value = await loader();
    if (value != null) {
      entry.value = value;
      entry.expiresAt = Date.now() + resolveTtl();
    } else if (entry.value == null) {
      // Nothing cached and nothing returned — retry on the next request rather
      // than caching the emptiness.
      cache.delete(key);
    } else {
      // Keep serving the previous catalog, but try again soon.
      entry.expiresAt = Date.now() + Math.min(resolveTtl(), 30_000);
    }
    return entry.value ?? null;
  } catch {
    if (entry.value == null) cache.delete(key);
    else entry.expiresAt = Date.now() + Math.min(resolveTtl(), 30_000);
    return entry.value ?? null;
  } finally {
    entry.inflight = null;
  }
}

/**
 * Drop cached upstream catalogs. Called after anything that can change which
 * account a catalog was fetched for (connection added/edited/removed), so the
 * next /v1/models reflects the new credentials instead of the old account's
 * models.
 *
 * @param {string} [prefix] - clear only keys starting with this; omit for all.
 */
export function invalidateUpstreamModels(prefix) {
  if (!prefix) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

/** Test/debug helper: current entry count. */
export function upstreamCacheSize() {
  return cache.size;
}
