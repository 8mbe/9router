import { randomUUID } from "node:crypto";
import { getProviderConnectionById } from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { setModelProbe } from "@/lib/db/repos/modelProbesRepo.js";
import { probeConnectionModel, fetchModelContextLengths } from "./probe";

export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 16;
export const DEFAULT_CONCURRENCY = 4;

// Finished jobs are kept briefly so a poll that arrives after the last task can
// still read the summary, then evicted so a long-lived server does not accumulate them.
const JOB_TTL_MS = 10 * 60 * 1000;
const MAX_JOBS = 50;

// Next.js reloads route modules in dev; a bare module-level Map would lose running
// jobs on the next edit and orphan their pollers.
const store = (globalThis.__nineRouterModelProbeJobs ||= new Map());

export function clampConcurrency(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.floor(n)));
}

function evictStale() {
  const now = Date.now();
  for (const [id, job] of store) {
    if (job.finishedAt && now - new Date(job.finishedAt).getTime() > JOB_TTL_MS) store.delete(id);
  }
  while (store.size > MAX_JOBS) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

function taskKey(connectionId, modelId) {
  return `${connectionId}::${modelId}`;
}

export function serializeJob(job) {
  if (!job) return null;
  return {
    jobId: job.id,
    providerId: job.providerId,
    providerAlias: job.providerAlias,
    status: job.status,
    concurrency: job.concurrency,
    total: job.total,
    completed: job.completed,
    passed: job.passed,
    failed: job.failed,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    tasks: [...job.tasks.values()],
  };
}

export function getJob(jobId) {
  evictStale();
  return store.get(jobId) || null;
}

export function cancelJob(jobId) {
  const job = store.get(jobId);
  if (!job || job.status !== "running") return false;
  job.cancelled = true;
  job.controller.abort();
  return true;
}

/** The newest job for a provider, so a page reload can re-attach to a run in flight. */
export function findLatestJobForProvider(providerId) {
  evictStale();
  let latest = null;
  for (const job of store.values()) {
    if (job.providerId !== providerId) continue;
    if (!latest || new Date(job.createdAt) > new Date(latest.createdAt)) latest = job;
  }
  return latest;
}

/**
 * Run `pairs` through `worker` with at most `limit` in flight. Plain index-cursor
 * pool rather than chunked Promise.all batches: a batch runs only as fast as its
 * slowest member, which on a list of models with wildly different latencies leaves
 * most of the concurrency budget idle.
 */
async function runPool(pairs, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, pairs.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= pairs.length) return;
      await worker(pairs[index]);
    }
  });
  await Promise.all(runners);
}

export const __test__ = { runPool };

/**
 * Start probing every (connection, model) pair in the background and return
 * immediately with a job the caller can poll.
 *
 * Each pair is one real completion against that connection's own base URL, so a key
 * that works for one model and not another shows up as two different verdicts rather
 * than one provider-level "connection OK". Verdicts are persisted as they land, so a
 * closed tab does not lose the run.
 */
export function startProbeJob({ providerId, providerAlias, connectionIds, models, concurrency }) {
  evictStale();

  const modelIds = [...new Set((models || []).map((m) => (typeof m === "string" ? m : m?.id)).filter(Boolean))];
  const connIds = [...new Set((connectionIds || []).filter(Boolean))];
  const pairs = [];
  for (const connectionId of connIds) {
    for (const modelId of modelIds) pairs.push({ connectionId, modelId });
  }

  const job = {
    id: randomUUID(),
    providerId,
    providerAlias,
    status: pairs.length === 0 ? "done" : "running",
    concurrency: clampConcurrency(concurrency),
    total: pairs.length,
    completed: 0,
    passed: 0,
    failed: 0,
    createdAt: new Date().toISOString(),
    finishedAt: pairs.length === 0 ? new Date().toISOString() : null,
    cancelled: false,
    controller: new AbortController(),
    tasks: new Map(
      pairs.map(({ connectionId, modelId }) => [
        taskKey(connectionId, modelId),
        { connectionId, modelId, state: "queued", ok: null, error: null, latencyMs: null, status: null, contextLength: null },
      ])
    ),
  };
  store.set(job.id, job);
  if (pairs.length === 0) return job;

  // Deliberately not awaited: the route returns the job id and the client polls.
  (async () => {
    // One connection read + one proxy resolve + one /models read per connection,
    // rather than per pair — a 3-key × 40-model run would otherwise make 120 of each.
    const connCache = new Map();
    const loadConnection = async (connectionId) => {
      if (connCache.has(connectionId)) return connCache.get(connectionId);
      const entry = (async () => {
        const connection = await getProviderConnectionById(connectionId);
        if (!connection) return { connection: null, proxy: null, contexts: {} };
        const proxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
        const contexts = await fetchModelContextLengths(connection, { proxy });
        return { connection, proxy, contexts };
      })();
      connCache.set(connectionId, entry);
      return entry;
    };

    try {
      await runPool(pairs, job.concurrency, async ({ connectionId, modelId }) => {
        const key = taskKey(connectionId, modelId);
        if (job.cancelled) {
          const task = job.tasks.get(key);
          if (task && task.state === "queued") task.state = "cancelled";
          return;
        }

        const task = job.tasks.get(key);
        task.state = "testing";

        const { connection, proxy, contexts } = await loadConnection(connectionId);
        let result;
        if (!connection) {
          result = { ok: false, error: "Connection not found", latencyMs: 0, status: null };
        } else {
          result = await probeConnectionModel(connection, modelId, { proxy, signal: job.controller.signal });
        }

        const contextLength = contexts?.[modelId] ?? null;
        task.state = job.cancelled && !result.ok ? "cancelled" : "done";
        task.ok = result.ok;
        task.error = result.error || null;
        task.latencyMs = result.latencyMs ?? null;
        task.status = result.status ?? null;
        task.note = result.note || null;
        task.contextLength = contextLength;

        if (task.state === "done") {
          job.completed += 1;
          if (result.ok) job.passed += 1; else job.failed += 1;
          try {
            await setModelProbe({
              connectionId,
              providerAlias,
              modelId,
              ok: result.ok,
              error: result.error,
              status: result.status,
              latencyMs: result.latencyMs,
              note: result.note,
              contextLength,
            });
          } catch (err) {
            // A persistence failure must not abort the run — the in-memory job is
            // still the source of truth for the poller.
            console.log("[model-probe] failed to persist verdict:", err?.message);
          }
        }
      });
    } catch (err) {
      console.log("[model-probe] job failed:", err?.message);
    } finally {
      job.status = job.cancelled ? "cancelled" : "done";
      job.finishedAt = new Date().toISOString();
    }
  })();

  return job;
}
