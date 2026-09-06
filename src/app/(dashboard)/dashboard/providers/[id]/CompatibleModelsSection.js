"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import PropTypes from "prop-types";
import { Button } from "@/shared/components";
import { getProviderCustomModelRows } from "@/shared/utils/providerCustomModels";
import { extractContextLength, formatContextLength } from "@/lib/modelProbe/contextLength";

const CONCURRENCY_KEY = "9router.modelProbe.concurrency";
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 16;
const DEFAULT_CONCURRENCY = 4;
const POLL_INTERVAL_MS = 1200;

function clampConcurrency(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.floor(n)));
}

/**
 * The concurrency setting lives in localStorage so it survives navigation, and is
 * read through useSyncExternalStore rather than an effect — that keeps SSR rendering
 * the default without a hydration mismatch, and syncs other tabs for free.
 */
const concurrencyStore = (() => {
  const listeners = new Set();
  let cache = null;

  const read = () => {
    try {
      return clampConcurrency(window.localStorage.getItem(CONCURRENCY_KEY) ?? DEFAULT_CONCURRENCY);
    } catch {
      return DEFAULT_CONCURRENCY;
    }
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      const onStorage = (e) => {
        if (e.key !== null && e.key !== CONCURRENCY_KEY) return;
        cache = null;
        listeners.forEach((l) => l());
      };
      window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(listener);
        window.removeEventListener("storage", onStorage);
      };
    },
    // Cached so repeated renders get a referentially stable snapshot.
    getSnapshot() {
      if (cache === null) cache = read();
      return cache;
    },
    getServerSnapshot() {
      return DEFAULT_CONCURRENCY;
    },
    set(value) {
      cache = clampConcurrency(value);
      try { window.localStorage.setItem(CONCURRENCY_KEY, String(cache)); } catch { /* non-fatal */ }
      listeners.forEach((l) => l());
    },
  };
})();

function shortKeyLabel(connection) {
  return connection?.name || connection?.email || connection?.label || `Key ${String(connection?.id || "").slice(0, 6)}`;
}

/**
 * One key's verdict for one model. Colour is the whole signal at a glance; the
 * title carries the error, which is what makes a red chip actionable.
 */
function KeyChip({ label, state, error, latencyMs, testedAt }) {
  const styles = {
    ok: "border-green-500/40 bg-green-500/10 text-green-600 dark:text-green-400",
    failed: "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400",
    testing: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    queued: "border-border bg-sidebar text-text-muted",
    unknown: "border-border bg-sidebar text-text-muted",
  }[state] || "border-border bg-sidebar text-text-muted";

  const icon = {
    ok: "check_circle",
    failed: "cancel",
    testing: "progress_activity",
    queued: "schedule",
    unknown: "help",
  }[state] || "help";

  const tooltipParts = [label];
  if (state === "ok") tooltipParts.push(latencyMs != null ? `works (${latencyMs}ms)` : "works");
  else if (state === "failed") tooltipParts.push(error || "failed");
  else if (state === "testing") tooltipParts.push("testing…");
  else if (state === "queued") tooltipParts.push("queued");
  else tooltipParts.push("not tested yet");
  if (testedAt) tooltipParts.push(new Date(testedAt).toLocaleString());

  return (
    <span
      title={tooltipParts.join(" — ")}
      className={`inline-flex max-w-[220px] items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${styles}`}
    >
      <span
        className="material-symbols-outlined text-[13px]"
        style={state === "testing" ? { animation: "spin 1s linear infinite" } : undefined}
      >
        {icon}
      </span>
      <span className="truncate">{label}</span>
    </span>
  );
}

KeyChip.propTypes = {
  label: PropTypes.string.isRequired,
  state: PropTypes.string,
  error: PropTypes.string,
  latencyMs: PropTypes.number,
  testedAt: PropTypes.string,
};

function CompatibleModelRow({
  modelId, fullModel, contextLength, copied, onCopy, onDeleteAlias,
  onTest, isTesting, connections, keyStates,
}) {
  const anyOk = connections.some((c) => keyStates[c.id]?.state === "ok");
  const anyFailed = connections.some((c) => keyStates[c.id]?.state === "failed");
  const anyTested = anyOk || anyFailed;

  const borderColor = anyOk
    ? "border-green-500/40"
    : anyTested
    ? "border-red-500/40"
    : "border-border";

  const iconColor = anyOk ? "#22c55e" : anyTested ? "#ef4444" : undefined;
  const contextLabel = formatContextLength(contextLength);

  return (
    <div className={`flex items-start gap-3 p-3 rounded-lg border ${borderColor} hover:bg-sidebar/50`}>
      <span
        className="material-symbols-outlined text-base text-text-muted mt-0.5"
        style={iconColor ? { color: iconColor } : undefined}
      >
        {anyOk ? "check_circle" : anyTested ? "cancel" : "smart_toy"}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <p className="text-sm font-medium truncate">{modelId}</p>
          <span
            className={`flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-mono ${
              contextLabel ? "bg-primary/10 text-primary" : "bg-sidebar text-text-muted"
            }`}
            title={contextLabel ? `${Number(contextLength).toLocaleString()} token context window` : "Context window unknown — import from /models or run a test to detect it"}
          >
            {contextLabel ? `${contextLabel} ctx` : "ctx ?"}
          </span>
        </div>

        <div className="flex items-center gap-1 mt-1">
          <code className="text-xs text-text-muted font-mono bg-sidebar px-1.5 py-0.5 rounded">{fullModel}</code>
          <div className="relative group/btn">
            <button
              onClick={() => onCopy(fullModel, `model-${modelId}`)}
              className="p-0.5 hover:bg-sidebar rounded text-text-muted hover:text-primary"
            >
              <span className="material-symbols-outlined text-sm">
                {copied === `model-${modelId}` ? "check" : "content_copy"}
              </span>
            </button>
            <span className="pointer-events-none absolute top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
              {copied === `model-${modelId}` ? "Copied!" : "Copy"}
            </span>
          </div>
          {onTest && (
            <div className="relative group/btn">
              <button
                onClick={onTest}
                disabled={isTesting}
                className="p-0.5 hover:bg-sidebar rounded text-text-muted hover:text-primary transition-colors"
              >
                <span className="material-symbols-outlined text-sm" style={isTesting ? { animation: "spin 1s linear infinite" } : undefined}>
                  {isTesting ? "progress_activity" : "science"}
                </span>
              </button>
              <span className="pointer-events-none absolute top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
                {isTesting ? "Testing..." : "Test every key"}
              </span>
            </div>
          )}
        </div>

        {connections.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {connections.map((connection) => {
              const entry = keyStates[connection.id] || {};
              return (
                <KeyChip
                  key={connection.id}
                  label={shortKeyLabel(connection)}
                  state={entry.state || "unknown"}
                  error={entry.error}
                  latencyMs={entry.latencyMs}
                  testedAt={entry.testedAt}
                />
              );
            })}
          </div>
        )}
      </div>
      <button
        onClick={onDeleteAlias}
        className="p-1 hover:bg-red-50 rounded text-red-500"
        title="Remove model"
      >
        <span className="material-symbols-outlined text-sm">delete</span>
      </button>
    </div>
  );
}

CompatibleModelRow.propTypes = {
  modelId: PropTypes.string.isRequired,
  fullModel: PropTypes.string.isRequired,
  contextLength: PropTypes.number,
  copied: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  onDeleteAlias: PropTypes.func.isRequired,
  onTest: PropTypes.func,
  isTesting: PropTypes.bool,
  connections: PropTypes.array.isRequired,
  keyStates: PropTypes.object.isRequired,
};

export default function CompatibleModelsSection({
  providerStorageAlias, providerDisplayAlias, modelAliases, customModels,
  copied, onCopy, onDeleteAlias, onAddCustomModel, onDeleteCustomModel,
  connections, isAnthropic, searchQuery = "",
}) {
  const [newModel, setNewModel] = useState("");
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const concurrency = useSyncExternalStore(
    concurrencyStore.subscribe,
    concurrencyStore.getSnapshot,
    concurrencyStore.getServerSnapshot,
  );
  const [job, setJob] = useState(null);
  const [probes, setProbes] = useState([]);
  const [probeError, setProbeError] = useState("");
  const [startingProbe, setStartingProbe] = useState(false);
  const pollTimer = useRef(null);

  const activeConnection = useMemo(
    () => connections.find((conn) => conn.isActive !== false) || connections[0] || null,
    [connections]
  );
  // Only keys that can actually serve traffic are probed, so the chip row matches
  // what the router would really try.
  const testableConnections = useMemo(
    () => connections.filter((conn) => conn.isActive !== false),
    [connections]
  );

  const updateConcurrency = (value) => concurrencyStore.set(value);

  const probeUrl = activeConnection ? `/api/providers/${activeConnection.id}/model-probe` : null;

  // Bumped to force a re-read of stored verdicts (after a run finishes, or a clear).
  const [probeRefresh, setProbeRefresh] = useState(0);
  const reloadProbes = () => setProbeRefresh((n) => n + 1);

  useEffect(() => {
    if (!probeUrl) return undefined;
    let ignore = false;
    (async () => {
      try {
        const res = await fetch(probeUrl, { cache: "no-store" });
        const data = await res.json();
        if (ignore || !res.ok) return;
        setProbes(data.probes || []);
        // Re-attach to a run still in flight after a reload or tab switch.
        if (data.job && data.job.status === "running") setJob(data.job);
      } catch { /* transient — the next poll or action retries */ }
    })();
    return () => { ignore = true; };
  }, [probeUrl, probeRefresh]);

  // Poll only while a job is actually running; the tick that observes the finish
  // also refreshes stored verdicts, so the chips settle on persisted state.
  useEffect(() => {
    if (!job || job.status !== "running" || !probeUrl) return undefined;
    let cancelled = false;

    const tick = async () => {
      try {
        const res = await fetch(`${probeUrl}?jobId=${encodeURIComponent(job.jobId)}`, { cache: "no-store" });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) { setJob((prev) => (prev ? { ...prev, status: "done" } : prev)); return; }
        setJob(data.job);
        if (data.job?.status !== "running") reloadProbes();
      } catch {
        if (!cancelled) setJob((prev) => (prev ? { ...prev, status: "done" } : prev));
      }
    };

    pollTimer.current = setInterval(tick, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(pollTimer.current); };
  }, [job, probeUrl]);

  const allModels = useMemo(
    () => getProviderCustomModelRows({
      customModels,
      modelAliases,
      providerAlias: providerStorageAlias,
      type: "llm",
    }),
    [customModels, modelAliases, providerStorageAlias]
  );

  /**
   * Stored verdicts first, then overlay anything the running job has already
   * produced — a live "testing" chip must win over the previous run's verdict.
   */
  const keyStatesByModel = useMemo(() => {
    const map = {};
    const ensure = (modelId) => (map[modelId] ||= {});

    for (const probe of probes) {
      if (probe.providerAlias !== providerStorageAlias) continue;
      ensure(probe.modelId)[probe.connectionId] = {
        state: probe.ok ? "ok" : "failed",
        error: probe.error,
        latencyMs: probe.latencyMs,
        testedAt: probe.testedAt,
      };
    }

    if (job?.tasks) {
      for (const task of job.tasks) {
        const slot = ensure(task.modelId);
        if (task.state === "done") {
          slot[task.connectionId] = {
            state: task.ok ? "ok" : "failed",
            error: task.error,
            latencyMs: task.latencyMs,
            testedAt: null,
          };
        } else if (task.state === "testing" || task.state === "queued") {
          slot[task.connectionId] = { state: task.state, error: null, latencyMs: null, testedAt: null };
        }
      }
    }
    return map;
  }, [probes, job, providerStorageAlias]);

  // Context comes from the model record; a verdict that carried one is the fallback,
  // so a model added by hand still shows a window once it has been tested.
  const contextByModel = useMemo(() => {
    const map = {};
    for (const probe of probes) {
      if (probe.providerAlias !== providerStorageAlias) continue;
      if (probe.contextLength != null && map[probe.modelId] == null) map[probe.modelId] = probe.contextLength;
    }
    for (const task of job?.tasks || []) {
      if (task.contextLength != null) map[task.modelId] = task.contextLength;
    }
    return map;
  }, [probes, job, providerStorageAlias]);

  // Search narrows only what is *rendered*. Counts, "Test all" and the pair total
  // stay on allModels, so a filtered view never silently tests a subset.
  const visibleModels = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return allModels;
    return allModels.filter(({ id, alias }) =>
      id.toLowerCase().includes(query) || (alias || "").toLowerCase().includes(query)
    );
  }, [allModels, searchQuery]);

  const runningModelIds = useMemo(() => {
    const set = new Set();
    if (job?.status !== "running") return set;
    for (const task of job.tasks || []) {
      if (task.state === "testing" || task.state === "queued") set.add(task.modelId);
    }
    return set;
  }, [job]);

  const startProbe = async (modelIds) => {
    if (!probeUrl || startingProbe) return;
    if (testableConnections.length === 0) {
      setProbeError("No active connection to test with.");
      return;
    }
    setStartingProbe(true);
    setProbeError("");
    try {
      const res = await fetch(probeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          models: modelIds,
          connectionIds: testableConnections.map((c) => c.id),
          concurrency,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setProbeError(data.error || "Failed to start tests"); return; }
      setJob(data.job);
    } catch (error) {
      setProbeError(error.message || "Failed to start tests");
    } finally {
      setStartingProbe(false);
    }
  };

  const stopProbe = async () => {
    if (!probeUrl || !job?.jobId) return;
    try {
      await fetch(`${probeUrl}?jobId=${encodeURIComponent(job.jobId)}`, { method: "DELETE" });
    } catch { /* the job ends on its own if the cancel never lands */ }
  };

  const clearProbes = async () => {
    if (!probeUrl) return;
    try {
      await fetch(probeUrl, { method: "DELETE" });
      setProbes([]);
      setJob(null);
    } catch { /* non-fatal */ }
  };

  const handleAdd = async () => {
    if (!newModel.trim() || adding) return;
    const modelId = newModel.trim();
    if (allModels.some((model) => model.id === modelId)) {
      alert("Model already exists for this provider.");
      return;
    }

    setAdding(true);
    try {
      await onAddCustomModel(modelId);
      setNewModel("");
    } catch (error) {
      console.log("Error adding model:", error);
    } finally {
      setAdding(false);
    }
  };

  const handleImport = async () => {
    if (importing || !activeConnection) return;

    setImporting(true);
    try {
      const res = await fetch(`/api/providers/${activeConnection.id}/models`);
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Failed to import models");
        return;
      }
      const models = data.models || [];
      if (models.length === 0) {
        alert("No models returned from /models.");
        return;
      }
      const existing = new Set(allModels.map((entry) => entry.id));
      let importedCount = 0;
      let contextCount = 0;
      for (const model of models) {
        const modelId = model.id || model.name || model.model;
        if (!modelId || existing.has(modelId)) continue;
        // The upstream entry is the only place the context window is advertised, so
        // it is read here rather than re-fetched later.
        const contextLength = extractContextLength(model);
        if (contextLength !== null) contextCount += 1;
        await onAddCustomModel(modelId, { contextLength });
        existing.add(modelId);
        importedCount += 1;
      }
      if (importedCount === 0) {
        alert("No new models were added.");
      } else {
        alert(`Added ${importedCount} model${importedCount === 1 ? "" : "s"} (${contextCount} with a context window).`);
      }
    } catch (error) {
      console.log("Error importing models:", error);
    } finally {
      setImporting(false);
    }
  };

  const canImport = !!activeConnection;
  const canTest = testableConnections.length > 0 && allModels.length > 0;
  const isRunning = job?.status === "running";
  const pairCount = allModels.length * testableConnections.length;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-muted">
        Add {isAnthropic ? "Anthropic" : "OpenAI"}-compatible models manually or import them from the /models endpoint.
      </p>

      <div className="flex items-end gap-2 flex-wrap">
        <div className="flex-1 min-w-[240px]">
          <label htmlFor="new-compatible-model-input" className="text-xs text-text-muted mb-1 block">Model ID</label>
          <input
            id="new-compatible-model-input"
            type="text"
            value={newModel}
            onChange={(e) => setNewModel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            placeholder={isAnthropic ? "claude-3-opus-20240229" : "gpt-4o"}
            className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
          />
        </div>
        <Button size="sm" icon="add" onClick={handleAdd} disabled={!newModel.trim() || adding}>
          {adding ? "Adding..." : "Add"}
        </Button>
        <Button size="sm" variant="secondary" icon="download" onClick={handleImport} disabled={!canImport || importing}>
          {importing ? "Importing..." : "Import from /models"}
        </Button>
      </div>

      {!canImport && (
        <p className="text-xs text-text-muted">
          Add a connection to enable importing models.
        </p>
      )}

      {allModels.length > 0 && (
        <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="probe-concurrency" className="text-xs text-text-muted mb-1 block">
                Parallel tests
              </label>
              <input
                id="probe-concurrency"
                type="number"
                min={MIN_CONCURRENCY}
                max={MAX_CONCURRENCY}
                value={concurrency}
                onChange={(e) => updateConcurrency(e.target.value)}
                disabled={isRunning}
                className="w-20 px-2 py-1.5 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary disabled:opacity-50"
              />
            </div>

            {isRunning ? (
              <Button size="sm" variant="secondary" icon="stop_circle" onClick={stopProbe}>
                Stop
              </Button>
            ) : (
              <Button
                size="sm"
                icon="science"
                onClick={() => startProbe(allModels.map((m) => m.id))}
                disabled={!canTest || startingProbe}
              >
                {startingProbe ? "Starting..." : "Test all keys × models"}
              </Button>
            )}

            <Button size="sm" variant="secondary" icon="delete_sweep" onClick={clearProbes} disabled={isRunning || probes.length === 0}>
              Clear results
            </Button>

            <p className="text-xs text-text-muted">
              {testableConnections.length} key{testableConnections.length === 1 ? "" : "s"} × {allModels.length} model
              {allModels.length === 1 ? "" : "s"} = {pairCount} test{pairCount === 1 ? "" : "s"}, {concurrency} at a time.
              Runs in the background — you can leave this page.
            </p>
          </div>

          {job && (
            <div className="flex flex-col gap-1">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-sidebar">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${job.total ? Math.round((job.completed / job.total) * 100) : 0}%` }}
                />
              </div>
              <p className="text-xs text-text-muted">
                {job.status === "running" ? "Testing" : job.status === "cancelled" ? "Stopped" : "Finished"}
                {" — "}{job.completed}/{job.total} done · {job.passed} working · {job.failed} failed
              </p>
            </div>
          )}

          {probeError && <p className="text-xs text-red-500">{probeError}</p>}
        </div>
      )}

      {allModels.length > 0 && visibleModels.length === 0 && (
        <p className="py-4 text-center text-sm text-text-muted">
          No models match &ldquo;{searchQuery.trim()}&rdquo;.
        </p>
      )}

      {visibleModels.length > 0 && (
        <div className="flex flex-col gap-3">
          {visibleModels.map(({ id, alias, source, contextLength }) => (
            <CompatibleModelRow
              key={`${source}-${providerStorageAlias}/${id}`}
              modelId={id}
              fullModel={`${providerDisplayAlias}/${id}`}
              contextLength={contextLength ?? contextByModel[id] ?? null}
              copied={copied}
              onCopy={onCopy}
              onDeleteAlias={() => source === "custom" ? onDeleteCustomModel(id) : onDeleteAlias(alias)}
              onTest={canTest ? () => startProbe([id]) : undefined}
              isTesting={runningModelIds.has(id)}
              connections={testableConnections}
              keyStates={keyStatesByModel[id] || {}}
            />
          ))}
        </div>
      )}
    </div>
  );
}

CompatibleModelsSection.propTypes = {
  providerStorageAlias: PropTypes.string.isRequired,
  providerDisplayAlias: PropTypes.string.isRequired,
  modelAliases: PropTypes.object.isRequired,
  customModels: PropTypes.arrayOf(PropTypes.object),
  copied: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  onDeleteAlias: PropTypes.func.isRequired,
  onAddCustomModel: PropTypes.func.isRequired,
  onDeleteCustomModel: PropTypes.func.isRequired,
  connections: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    isActive: PropTypes.bool,
  })).isRequired,
  isAnthropic: PropTypes.bool,
  searchQuery: PropTypes.string,
};
