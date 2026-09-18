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
//
// Two rules keep a *failing* upstream from costing the whole response:
//
//   • Negative caching. An upstream that returns nothing is remembered as
//     "empty" for a short window instead of being retried on the very next
//     request. Without it a dead endpoint burns its full timeout on every
//     single /v1/models call, forever — one unreachable host was adding 5s to
//     each request while the catalogue it would have contributed was already
//     covered by the static table.
//   • A cold-wait budget. Even a first, uncached load only blocks the response
//     for so long; past that the request falls back to the static catalog and
//     the fetch keeps running to fill the cache for next time.

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_FAILURE_TTL_MS = 60 * 1000;
const DEFAULT_COLD_WAIT_MS = 1500;

function resolveEnvMs(name, fallback) {
  const raw = Number(process.env[name]);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return fallback;
}

function resolveTtl() {
  return resolveEnvMs("MODELS_CACHE_TTL_MS", DEFAULT_TTL_MS);
}

/** How long an empty/failed upstream is left alone before we try it again. */
function resolveFailureTtl() {
  return resolveEnvMs("MODELS_CACHE_FAILURE_TTL_MS", DEFAULT_FAILURE_TTL_MS);
}

/** How long a request will block on a cold load before falling back. 0 = wait forever. */
function resolveColdWaitMs() {
  return resolveEnvMs("MODELS_CACHE_COLD_WAIT_MS", DEFAULT_COLD_WAIT_MS);
}

/** @type {Map<string, { value: any, expiresAt: number, failedUntil: number, inflight: Promise<any> | null, startedAt: number }>} */
const cache = new Map();

/**
 * Resolve `key` through the cache, calling `loader` only when there is nothing
 * fresh to serve and the last attempt was not a recent failure.
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
  const entry = cache.get(key);
  const now = Date.now();

  if (entry && entry.value != null) {
    if (now < entry.expiresAt) return entry.value;
    // Expired but usable: hand back the stale value and refresh behind it, so a
    // request never pays the upstream latency once the cache is warm.
    if (!entry.inflight) {
      entry.startedAt = now;
      entry.inflight = revalidate(key, loader, entry);
    }
    return entry.value;
  }

  // This upstream came back empty recently. Skip it entirely — the caller falls
  // back to its static catalog, and we retry once the failure window lapses.
  if (entry && entry.value == null && !entry.inflight && now < entry.failedUntil) {
    return null;
  }

  // Cold (or previously failed): the caller may have to wait, but concurrent
  // callers share the single in-flight load, and nobody waits past the budget.
  // The budget runs from when the load STARTED, not from when this caller
  // joined it — otherwise a request arriving late behind a slow load waits the
  // full budget again for a fetch that is already nearly timed out.
  if (entry?.inflight) return waitWithBudget(entry.inflight, entry.startedAt);

  const pending = {
    value: entry?.value ?? null,
    expiresAt: 0,
    failedUntil: 0,
    inflight: null,
    startedAt: now,
  };
  cache.set(key, pending);
  pending.inflight = revalidate(key, loader, pending);
  return waitWithBudget(pending.inflight, pending.startedAt);
}

/**
 * Wait on a cold load, but give up after the budget and let the caller fall
 * back. The load itself is NOT cancelled — it keeps running and populates the
 * cache, so the next request is served from it.
 */
function waitWithBudget(inflight, startedAt) {
  const budget = resolveColdWaitMs();
  if (budget <= 0) return inflight.then((v) => v ?? null, () => null);

  const remaining = budget - (Date.now() - (startedAt || Date.now()));
  if (remaining <= 0) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value ?? null);
    };
    const timer = setTimeout(() => finish(null), remaining);
    // Never hold the process open just for a models refresh.
    if (typeof timer.unref === "function") timer.unref();
    inflight.then(finish, () => finish(null));
  });
}

async function revalidate(key, loader, entry) {
  try {
    const value = await loader();
    if (value != null) {
      entry.value = value;
      entry.expiresAt = Date.now() + resolveTtl();
      entry.failedUntil = 0;
    } else if (entry.value == null) {
      // Nothing cached and nothing returned. Remember the emptiness briefly so
      // a dead endpoint does not cost a full timeout on every request; the
      // entry is retried once the failure window lapses.
      entry.failedUntil = Date.now() + resolveFailureTtl();
    } else {
      // Keep serving the previous catalog, but try again soon.
      entry.expiresAt = Date.now() + Math.min(resolveTtl(), 30_000);
    }
    return entry.value ?? null;
  } catch {
    if (entry.value == null) entry.failedUntil = Date.now() + resolveFailureTtl();
    else entry.expiresAt = Date.now() + Math.min(resolveTtl(), 30_000);
    return entry.value ?? null;
  } finally {
    entry.inflight = null;
    // A failure window of 0 means "retry immediately", which is what an absent
    // entry already does — drop it so the cache does not accumulate misses.
    if (entry.value == null && entry.failedUntil <= Date.now() && cache.get(key) === entry) {
      cache.delete(key);
    }
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
