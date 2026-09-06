import {
  getProviderAlias,
  isOpenAICompatibleProvider,
  isAnthropicCompatibleProvider,
} from "@/shared/constants/providers";

/**
 * The alias custom models are stored under. Compatible providers are keyed by their
 * own id (each user-defined node is its own namespace); everything else uses the
 * registry alias. Shared so the probe route, the runtime recorder and the dashboard
 * all address the same rows.
 */
export function resolveProbeAlias(providerId) {
  const compatible = isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId);
  return compatible ? providerId : getProviderAlias(providerId);
}
