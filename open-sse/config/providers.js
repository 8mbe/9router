// Barrel: PROVIDERS now built from providers/registry (transport co-located with models)
import { PROVIDERS } from "../providers/index.js";
export { PROVIDERS, PROVIDER_OAUTH } from "../providers/index.js";

export const OLLAMA_LOCAL_DEFAULT_HOST = "http://localhost:11434";

export function resolveOllamaLocalHost(credentials) {
  const raw = credentials?.providerSpecificData?.baseUrl?.trim();
  return (raw || OLLAMA_LOCAL_DEFAULT_HOST).replace(/\/$/, "");
}

// Region URLs single-source from registry xiaomi-tokenplan.transport
export const XIAOMI_TOKENPLAN_REGIONS = PROVIDERS["xiaomi-tokenplan"]?.regions || {};
export const XIAOMI_TOKENPLAN_DEFAULT_REGION = PROVIDERS["xiaomi-tokenplan"]?.defaultRegion;

export function resolveXiaomiTokenplanBaseUrl(credentials) {
  const region = credentials?.providerSpecificData?.region;
  return XIAOMI_TOKENPLAN_REGIONS[region] || XIAOMI_TOKENPLAN_REGIONS[XIAOMI_TOKENPLAN_DEFAULT_REGION];
}

// cline-free runs Cline inside this process, so its "endpoint" is a marker, not a
// URL anything dials — single-sourced from the registry transport.
export const CLINE_INPROCESS_URL = PROVIDERS["cline-free"]?.baseUrl || "cline://core/inprocess";

// Cline's own fs/shell tools run as the 9router process user, so they stay opt-in.
export function clineToolsEnabled() {
  const raw = process.env.CLINE_ENABLE_TOOLS?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

// Working directory for those tools when they are enabled.
export function resolveClineWorkspaceRoot(credentials) {
  const fromConnection = credentials?.providerSpecificData?.workspaceRoot?.trim();
  return fromConnection || process.env.CLINE_WORKSPACE_ROOT?.trim() || process.cwd();
}
