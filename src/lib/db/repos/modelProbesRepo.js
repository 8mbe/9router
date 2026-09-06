import { makeKv } from "../helpers/kvStore.js";

// Per (connection, model) probe verdicts. Lives in the generic kv table, so no
// migration is needed — the scope is the namespace.
const probeKv = makeKv("modelProbes");

// Bumped on every write so read-through caches (routing hints, which run on the
// request hot path) can tell "nothing changed" from "must re-read" without a query.
let version = 0;
export function getModelProbesVersion() {
  return version;
}

// Same connection can be probed for many models, and the same model for many
// connections, so both halves are part of the key.
function probeKey(connectionId, providerAlias, modelId) {
  return `${connectionId}::${providerAlias}/${modelId}`;
}

function toRecord(value) {
  if (!value || typeof value !== "object") return null;
  return value;
}

/**
 * Every stored verdict, optionally narrowed. `connectionIds` is matched as a set so
 * the provider page can ask for just its own connections in one read.
 */
export async function getModelProbes({ providerAlias, connectionIds } = {}) {
  const all = await probeKv.getAll();
  const wanted = connectionIds ? new Set(connectionIds) : null;
  const out = [];
  for (const value of Object.values(all)) {
    const record = toRecord(value);
    if (!record) continue;
    if (providerAlias && record.providerAlias !== providerAlias) continue;
    if (wanted && !wanted.has(record.connectionId)) continue;
    out.push(record);
  }
  return out;
}

export async function setModelProbe({
  connectionId, providerAlias, modelId, ok, error = null, status = null,
  latencyMs = null, note = null, contextLength = null,
}) {
  if (!connectionId || !providerAlias || !modelId) return null;
  const record = {
    connectionId,
    providerAlias,
    modelId,
    ok: !!ok,
    error: error || null,
    status: status ?? null,
    latencyMs: latencyMs ?? null,
    note: note || null,
    contextLength: contextLength ?? null,
    testedAt: new Date().toISOString(),
  };
  await probeKv.set(probeKey(connectionId, providerAlias, modelId), record);
  version += 1;
  return record;
}

/** Drop verdicts for a whole connection, one model, or one exact pair. */
export async function clearModelProbes({ connectionId, providerAlias, modelId } = {}) {
  if (connectionId && providerAlias && modelId) {
    await probeKv.remove(probeKey(connectionId, providerAlias, modelId));
    version += 1;
    return 1;
  }
  const all = await probeKv.getAll();
  let removed = 0;
  for (const [key, value] of Object.entries(all)) {
    const record = toRecord(value);
    if (!record) continue;
    if (connectionId && record.connectionId !== connectionId) continue;
    if (providerAlias && record.providerAlias !== providerAlias) continue;
    if (modelId && record.modelId !== modelId) continue;
    await probeKv.remove(key);
    removed += 1;
  }
  if (removed) version += 1;
  return removed;
}
