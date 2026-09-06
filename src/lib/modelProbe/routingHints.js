import { getModelProbes, setModelProbe, getModelProbesVersion } from "@/lib/db/repos/modelProbesRepo.js";
import { resolveProbeAlias } from "./alias";

// A failed verdict stops demoting a key after this long. Provider-side state changes
// — a plan upgrade, a restored quota, a model rolled out to an account — must not be
// permanently invisible because of one stale probe.
export const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

// Ceiling on how long a cached snapshot may serve the hot path when nothing has been
// written. The version counter already catches in-process writes immediately; this
// only bounds staleness from another process sharing the DB file.
const CACHE_TTL_MS = 15000;

let cache = { at: 0, version: -1, byKey: new Map() };

export function invalidateProbeHints() {
  cache = { at: 0, version: -1, byKey: new Map() };
}

function hintKey(connectionId, modelId) {
  return `${connectionId}::${modelId}`;
}

/**
 * Read-through snapshot of every stored verdict, keyed by (connection, model).
 *
 * connectionId already scopes a row to one provider, so the alias is deliberately not
 * part of the lookup key — routing can match without having to reconstruct it.
 */
export async function getProbeHints() {
  const version = getModelProbesVersion();
  const fresh = cache.version === version && Date.now() - cache.at < CACHE_TTL_MS;
  if (fresh) return cache.byKey;

  const byKey = new Map();
  try {
    for (const probe of await getModelProbes()) {
      if (!probe?.connectionId || !probe?.modelId) continue;
      byKey.set(hintKey(probe.connectionId, probe.modelId), {
        ok: !!probe.ok,
        testedAt: probe.testedAt ? new Date(probe.testedAt).getTime() : 0,
      });
    }
  } catch {
    // Never let a hint lookup break routing — an empty map means "no opinion",
    // which is exactly the pre-existing behaviour.
    return cache.byKey;
  }

  cache = { at: Date.now(), version, byKey };
  return byKey;
}

/**
 * Split candidates by what we know about each key for THIS model.
 *
 * - working: probed OK (any age — a positive result staying positive is the useful case)
 * - broken:  probed failed, recently enough to still believe
 * - unknown: never probed, or the failure is old enough to be worth re-checking
 */
export function partitionByProbe(connections, model, hints, staleAfterMs = DEFAULT_STALE_AFTER_MS) {
  const working = [];
  const unknown = [];
  const broken = [];
  if (!model || !hints || hints.size === 0) return { working, unknown: [...connections], broken };

  const now = Date.now();
  for (const conn of connections) {
    const hint = hints.get(hintKey(conn.id, model));
    if (!hint) { unknown.push(conn); continue; }
    if (hint.ok) { working.push(conn); continue; }
    if (hint.testedAt && now - hint.testedAt > staleAfterMs) unknown.push(conn);
    else broken.push(conn);
  }
  return { working, unknown, broken };
}

/**
 * Candidate pool for a request: everything except keys we recently proved cannot
 * serve this model, with proven-working keys ordered first.
 *
 * Untested keys stay in the pool rather than being ranked below working ones only
 * — restricting traffic to the one key that happens to have been probed would
 * collapse rotation onto it and leave the rest permanently untried. Broken keys come
 * back only if excluding them would leave nothing to try, so a wrong verdict costs a
 * slower request, never a dead provider.
 */
export function orderConnectionsByProbe(connections, model, hints, staleAfterMs = DEFAULT_STALE_AFTER_MS) {
  const { working, unknown, broken } = partitionByProbe(connections, model, hints, staleAfterMs);
  const pool = [...working, ...unknown];
  if (pool.length > 0) return { pool, working, unknown, broken, demoted: broken.length };
  return { pool: broken, working, unknown, broken, demoted: 0 };
}

// 429/5xx/timeouts are transient and already handled by modelLock cooldowns; recording
// them here would teach routing to avoid a key that is merely busy.
const DURABLE_STATUSES = new Set([401, 403, 404]);
const DURABLE_400_HINT = /(model).*(not found|not exist|unsupported|no access|invalid|not available|unavailable)|(?:not found|unsupported|invalid).*(model)/i;

export function isDurableModelFailure(status, errorText) {
  if (DURABLE_STATUSES.has(Number(status))) return true;
  // Plenty of gateways answer 400 for "no such model", but 400 is also what a genuinely
  // malformed user request returns — so it only counts with a model-shaped message.
  if (Number(status) === 400 && typeof errorText === "string") return DURABLE_400_HINT.test(errorText);
  return false;
}

/**
 * Fold a real request's outcome back into the stored verdicts, so routing keeps
 * learning without anyone pressing Test. Successes always record; failures record only
 * when durable. Fail-open: a write problem must never surface in the request path.
 */
export async function recordLiveOutcome({ connectionId, providerId, modelId, ok, status = null, error = null }) {
  if (!connectionId || connectionId === "noauth" || !providerId || !modelId) return false;
  if (!ok && !isDurableModelFailure(status, error)) return false;

  try {
    await setModelProbe({
      connectionId,
      providerAlias: resolveProbeAlias(providerId),
      modelId,
      ok: !!ok,
      error: ok ? null : (typeof error === "string" ? error.slice(0, 240) : null),
      status,
    });
    return true;
  } catch {
    return false;
  }
}
