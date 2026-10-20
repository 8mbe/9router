"use client";

import { useState, useCallback, useEffect } from "react";
import PropTypes from "prop-types";
import { Card, Button, Modal } from "@/shared/components";
import { getModelsByProviderId, getModelKind } from "@/shared/constants/models";
import { getProviderAlias } from "@/shared/constants/providers";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import ModelTestResults, { ModelTestControls } from "@/shared/components/ModelTestResults";
import { inferCompatibleModelKind } from "@/shared/utils/compatibleMedia";

// ── ModelRow ───────────────────────────────────────────────────
export function ModelRow({ model, fullModel, copied, onCopy, testStatus, testResults, testingType, allowEssay, isCustom, isFree, onDeleteAlias, onTest, isTesting }) {
  const borderColor = testStatus === "ok" ? "border-green-500/40" : testStatus === "error" ? "border-red-500/40" : "border-border";
  const iconColor = testStatus === "ok" ? "#22c55e" : testStatus === "error" ? "#ef4444" : undefined;

  return (
    <div className={`group w-full sm:w-auto min-w-0 max-w-full px-3 py-2 rounded-lg border ${borderColor} hover:bg-sidebar/50`}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="material-symbols-outlined text-base" style={iconColor ? { color: iconColor } : undefined}>
          {testStatus === "ok" ? "check_circle" : testStatus === "error" ? "cancel" : "smart_toy"}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <code className="break-all text-xs text-text-muted font-mono bg-sidebar px-1.5 py-0.5 rounded">{fullModel}</code>
          <span className="flex items-center gap-1 pl-1">
            {model.name && <span className="text-[9px] text-text-muted/70 italic">{model.name}</span>}
          </span>
        </div>
        <div className="relative group/btn">
          <button onClick={() => onCopy(fullModel, `model-${model.id}`)} className="p-0.5 hover:bg-sidebar rounded text-text-muted hover:text-primary">
            <span className="material-symbols-outlined text-sm">{copied === `model-${model.id}` ? "check" : "content_copy"}</span>
          </button>
          <span className="pointer-events-none absolute mt-1 top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
            {copied === `model-${model.id}` ? "Copied!" : "Copy"}
          </span>
        </div>
        {isFree && <span className="text-[10px] font-bold text-green-500 bg-green-500/10 px-1.5 py-0.5 rounded">FREE</span>}
        {isCustom && (
          <button onClick={onDeleteAlias} className="p-0.5 hover:bg-red-500/10 rounded text-text-muted hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity ml-auto" title="Remove custom model">
            <span className="material-symbols-outlined text-sm">close</span>
          </button>
        )}
      </div>
      {onTest && <div className="mt-2"><ModelTestControls onTest={onTest} isTesting={isTesting} testingType={testingType} allowEssay={allowEssay} /></div>}
      <ModelTestResults result={testResults?.ping} testType="ping" />
      <ModelTestResults result={testResults?.essay} testType="essay" />
    </div>
  );
}

ModelRow.propTypes = {
  model: PropTypes.shape({ id: PropTypes.string.isRequired }).isRequired,
  fullModel: PropTypes.string.isRequired,
  copied: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  testStatus: PropTypes.oneOf(["ok", "error"]),
  testResults: PropTypes.object,
  testingType: PropTypes.string,
  allowEssay: PropTypes.bool,
  isCustom: PropTypes.bool,
  isFree: PropTypes.bool,
  onDeleteAlias: PropTypes.func,
  onTest: PropTypes.func,
  isTesting: PropTypes.bool,
};

// ── AddCustomModelModal ────────────────────────────────────────
function AddCustomModelModal({ isOpen, onSave, onClose }) {
  const [modelId, setModelId] = useState("");

  const handleSave = () => {
    if (!modelId.trim()) return;
    onSave(modelId.trim());
    setModelId("");
  };

  return (
    <Modal isOpen={isOpen} title="Add Custom Model" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div>
          <label className="text-xs text-text-muted mb-1 block">Model ID</label>
          <input
            className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSave()}
            placeholder="e.g. tts-1-hd"
            autoFocus
          />
        </div>
        <div className="flex gap-2">
          <Button onClick={handleSave} fullWidth disabled={!modelId.trim()}>Add</Button>
          <Button onClick={onClose} variant="ghost" fullWidth>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}

AddCustomModelModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};

// ── ModelsCard ─────────────────────────────────────────────────
// Self-contained card: shows models for a provider, filtered by optional `kindFilter`.
// kindFilter: if provided, only shows models with matching type/kinds field.
export default function ModelsCard({ providerId, kindFilter, providerAliasOverride }) {
  const { copied, copy } = useCopyToClipboard();
  const [modelAliases, setModelAliases] = useState({});
  const [customModels, setCustomModels] = useState([]);
  const [upstreamModels, setUpstreamModels] = useState([]);
  const [modelTestResults, setModelTestResults] = useState({});
  const [testingModelId, setTestingModelId] = useState(null);
  const [testingType, setTestingType] = useState(null);
  const [showAddCustomModel, setShowAddCustomModel] = useState(false);

  const providerAlias = providerAliasOverride || getProviderAlias(providerId);
  const effectiveType = kindFilter || "llm";

  const fetchData = useCallback(async () => {
    try {
      const [aliasRes, customRes] = await Promise.all([
        fetch("/api/models/alias"),
        fetch("/api/models/custom", { cache: "no-store" }),
      ]);
      const aliasData = await aliasRes.json();
      const customData = await customRes.json();
      if (aliasRes.ok) setModelAliases(aliasData.aliases || {});
      if (customRes.ok) setCustomModels(customData.models || []);
    } catch (e) { console.log("ModelsCard fetch error:", e); }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    if (!kindFilter || !providerId.startsWith("openai-compatible-")) return undefined;
    let cancelled = false;
    fetch("/api/providers", { cache: "no-store" })
      .then((res) => res.json())
      .then(async (data) => {
        const connections = (data.connections || []).filter((c) => c.provider === providerId && c.isActive !== false);
        const lists = await Promise.all(connections.map(async (connection) => {
          const res = await fetch(`/api/providers/${connection.id}/models?kind=${encodeURIComponent(kindFilter)}`, { cache: "no-store" });
          return res.ok ? (await res.json()).models || [] : [];
        }));
        if (cancelled) return;
        const seen = new Set();
        setUpstreamModels(lists.flat().filter((model) => {
          if (!model?.id || (model.kind || inferCompatibleModelKind(model)) !== kindFilter || seen.has(model.id)) return false;
          seen.add(model.id);
          return true;
        }));
      })
      .catch(() => { if (!cancelled) setUpstreamModels([]); });
    return () => { cancelled = true; };
  }, [providerId, kindFilter]);

  const handleSetAlias = async (modelId, alias) => {
    const fullModel = `${providerAlias}/${modelId}`;
    try {
      const res = await fetch("/api/models/alias", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: fullModel, alias }),
      });
      if (res.ok) await fetchData();
    } catch (e) { console.log("set alias error:", e); }
  };

  const handleDeleteAlias = async (alias) => {
    try {
      const res = await fetch(`/api/models/alias?alias=${encodeURIComponent(alias)}`, { method: "DELETE" });
      if (res.ok) await fetchData();
    } catch (e) { console.log("delete alias error:", e); }
  };

  const handleAddCustomModel = async (modelId) => {
    try {
      const res = await fetch("/api/models/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerAlias, id: modelId, type: effectiveType }),
      });
      if (res.ok) {
        // The POST answers with the resulting list; adding a model never changes
        // aliases, so refetching both is a wasted round trip.
        const data = await res.json().catch(() => null);
        if (Array.isArray(data?.models)) setCustomModels(data.models);
        else await fetchData();
        window.dispatchEvent(new CustomEvent("customModelChanged"));
      }
    } catch (e) { console.log("add custom model error:", e); }
  };

  const handleDeleteCustomModel = async (modelId) => {
    try {
      const params = new URLSearchParams({ providerAlias, id: modelId, type: effectiveType });
      const res = await fetch(`/api/models/custom?${params}`, { method: "DELETE" });
      if (res.ok) {
        await fetchData();
        window.dispatchEvent(new CustomEvent("customModelChanged"));
      }
    } catch (e) { console.log("delete custom model error:", e); }
  };

  const handleTestModel = async (modelId, testType = "ping") => {
    if (testingModelId) return;
    setTestingModelId(modelId);
    setTestingType(testType);
    try {
      const res = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: `${providerAlias}/${modelId}`, kind: kindFilter, testType }),
      });
      const data = await res.json();
      setModelTestResults((prev) => ({
        ...prev,
        [modelId]: { ...prev[modelId], status: data.ok ? "ok" : "error", [testType]: data },
      }));
    } catch (error) {
      setModelTestResults((prev) => ({ ...prev, [modelId]: {
        ...prev[modelId], status: "error", [testType]: { ok: false, error: error.message || "Network error" },
      } }));
    } finally { setTestingModelId(null); }
  };

  // Built-in models — filter by kindFilter if provided
  const allBuiltIn = getModelsByProviderId(providerId);
  const builtInModels = kindFilter
    ? allBuiltIn.filter((m) => {
        if (m.kinds) return m.kinds.includes(kindFilter);
        return getModelKind(m, "llm") === kindFilter;
      })
    : allBuiltIn;

  // Custom models for this provider + kind, dedupe vs built-in
  const myCustomModels = customModels.filter(
    (m) => m.providerAlias === providerAlias
      && getModelKind(m, "llm") === effectiveType
      && ![...builtInModels, ...upstreamModels].some((b) => b.id === m.id)
  );

  const displayModels = [...builtInModels, ...upstreamModels.filter((m) => !builtInModels.some((b) => b.id === m.id))];

  return (
    <>
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Models{kindFilter ? ` — ${kindFilter.toUpperCase()}` : ""}</h2>
        </div>

        <div className="flex flex-wrap items-start gap-3">
          {displayModels.map((model) => {
            const fullModel = `${providerAlias}/${model.id}`;
            const existingAlias = Object.entries(modelAliases).find(([, m]) => m === fullModel)?.[0];
            return (
              <ModelRow
                key={model.id}
                model={model}
                fullModel={`${providerAlias}/${model.id}`}
                alias={existingAlias}
                copied={copied}
                onCopy={copy}
                onSetAlias={(alias) => handleSetAlias(model.id, alias)}
                onDeleteAlias={() => handleDeleteAlias(existingAlias)}
                testStatus={modelTestResults[model.id]?.status}
                testResults={modelTestResults[model.id]}
                testingType={testingType}
                allowEssay={effectiveType === "llm"}
                onTest={kindFilter === "tts" ? undefined : (testType) => handleTestModel(model.id, testType)}
                isTesting={testingModelId === model.id}
                isFree={model.isFree}
              />
            );
          })}

          {myCustomModels.map((model) => (
            <ModelRow
              key={`${model.id}-${model.type}`}
              model={{ id: model.id, name: model.name }}
              fullModel={`${providerAlias}/${model.id}`}
              copied={copied}
              onCopy={copy}
              onSetAlias={() => {}}
              onDeleteAlias={() => handleDeleteCustomModel(model.id)}
              testStatus={modelTestResults[model.id]?.status}
              testResults={modelTestResults[model.id]}
              testingType={testingType}
              allowEssay={effectiveType === "llm"}
              onTest={kindFilter === "tts" ? undefined : (testType) => handleTestModel(model.id, testType)}
              isTesting={testingModelId === model.id}
              isCustom
            />
          ))}

          <button
            onClick={() => setShowAddCustomModel(true)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-dashed border-black/15 dark:border-white/15 text-xs text-text-muted hover:text-primary hover:border-primary/40 transition-colors"
          >
            <span className="material-symbols-outlined text-sm">add</span>
            Add Model
          </button>
        </div>
      </Card>

      <AddCustomModelModal
        isOpen={showAddCustomModel}
        onSave={async (modelId) => {
          await handleAddCustomModel(modelId);
          setShowAddCustomModel(false);
        }}
        onClose={() => setShowAddCustomModel(false)}
      />
    </>
  );
}

ModelsCard.propTypes = {
  providerId: PropTypes.string.isRequired,
  kindFilter: PropTypes.string, // e.g. "tts", "embedding" — filters models shown
  providerAliasOverride: PropTypes.string, // override alias (e.g. for custom-embedding nodes using prefix)
};
