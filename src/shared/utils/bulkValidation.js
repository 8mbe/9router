import { isAnthropicCompatibleProvider } from "../constants/providers.js";
import { CLAUDE_CODE } from "open-sse/config/claudeCodeConstants.js";

export function usesClaudeCodeModelCheck({ provider, providerSpecificData, model }) {
  return isAnthropicCompatibleProvider(provider)
    && providerSpecificData?.executionMode === CLAUDE_CODE.executionMode
    && typeof model === "string" && !!model.trim();
}

async function checkModel(credential, model, fetcher) {
  try {
    const response = await fetcher("/api/providers/validate-model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...credential, model }),
    });
    const data = await response.json().catch(() => ({}));
    if (data.error && data.ok === undefined) return { ok: false, supported: true, error: data.error };
    return {
      ok: !!data.ok,
      supported: data.supported !== false,
      error: data.error || null,
      ...(data.note != null ? { note: data.note } : {}),
      ...(data.latencyMs != null ? { latencyMs: data.latencyMs } : {}),
    };
  } catch {
    return { ok: false, supported: true, error: "Model check failed to run" };
  }
}

// A model response from Claude Code proves both key and model access. Direct key
// probes can be rejected by a gateway that requires Claude Code's request headers.
export async function validateBulkEntry({ provider, apiKey, providerSpecificData, model }, fetcher = fetch) {
  const credential = { provider, apiKey, providerSpecificData };
  const modelId = typeof model === "string" ? model.trim() : "";
  if (usesClaudeCodeModelCheck({ ...credential, model: modelId })) {
    const modelResult = await checkModel(credential, modelId, fetcher);
    return { keyValid: modelResult.ok, modelResult, testStatus: modelResult.ok ? "active" : "unknown" };
  }

  let keyValid = false;
  try {
    const response = await fetcher("/api/providers/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credential),
    });
    const data = await response.json().catch(() => ({}));
    keyValid = !!data.valid;
  } catch { /* A validation failure saves the entry with unknown status. */ }

  let modelResult = null;
  if (keyValid && modelId) {
    modelResult = await checkModel(credential, modelId, fetcher);
  }

  const modelOk = !modelResult || modelResult.ok || modelResult.supported === false;
  return { keyValid, modelResult, testStatus: keyValid && modelOk ? "active" : "unknown" };
}
