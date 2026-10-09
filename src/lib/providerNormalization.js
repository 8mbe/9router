import { AI_PROVIDERS, isAnthropicCompatibleProvider } from "../shared/constants/providers.js";

/**
 * Detect xAI Grok models by id pattern (grok-*, Grok_*, etc).
 * @param {string} modelId
 * @returns {boolean}
 */
export function isXaiModel(modelId) {
  return typeof modelId === "string" && /^grok[-_]/i.test(modelId.trim());
}

export function normalizeProviderId(provider) {
  if (typeof provider !== "string") return provider;

  const trimmed = provider.trim();
  if (AI_PROVIDERS[trimmed]) return trimmed;

  const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (AI_PROVIDERS[slug]) return slug;

  const providerByName = Object.values(AI_PROVIDERS).find(
    (entry) => entry.name?.toLowerCase() === trimmed.toLowerCase()
  );
  return providerByName?.id || trimmed;
}

export function validateConnectionExecutionMode(provider, providerSpecificData) {
  if (!providerSpecificData || !Object.prototype.hasOwnProperty.call(providerSpecificData, "executionMode")) {
    return null;
  }
  if (!isAnthropicCompatibleProvider(provider)) {
    return "Execution mode is only supported for custom Anthropic-compatible connections";
  }
  if (providerSpecificData.executionMode !== "direct" && providerSpecificData.executionMode !== "claude-code") {
    return "Execution mode must be direct or claude-code";
  }
  return null;
}

export function normalizeProviderSpecificData(provider, body = {}, providerSpecificData = null) {
  const next = providerSpecificData && typeof providerSpecificData === "object"
    ? { ...providerSpecificData }
    : {};

  if (isAnthropicCompatibleProvider(provider)) {
    next.executionMode = next.executionMode ?? "direct";
  }

  if (provider === "ollama-local") {
    const baseUrl = (
      next.baseUrl ||
      body.baseUrl ||
      body.baseURL ||
      body.ollamaHostUrl ||
      ""
    ).trim();

    if (baseUrl) next.baseUrl = baseUrl;
  }

  return Object.keys(next).length > 0 ? next : null;
}
