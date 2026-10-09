import REGISTRY from "open-sse/providers/registry/index.js";

// App-side aliases applied on top of the engine's registry-derived aliases.
export const LOCAL_PROVIDER_ALIASES = {
  xmtp: "xiaomi-tokenplan",
  "xiaomi-tokenplan": "xiaomi-tokenplan",
};

const RESERVED_PROVIDER_PREFIXES = new Map(Object.entries(LOCAL_PROVIDER_ALIASES));
for (const entry of REGISTRY) {
  RESERVED_PROVIDER_PREFIXES.set(entry.id, entry.id);
  if (entry.alias) RESERVED_PROVIDER_PREFIXES.set(entry.alias, entry.id);
  for (const alias of entry.aliases || []) RESERVED_PROVIDER_PREFIXES.set(alias, entry.id);
}

export function isReservedProviderPrefix(prefix) {
  return RESERVED_PROVIDER_PREFIXES.has(prefix);
}

export function getProviderPrefixError(prefix) {
  if (typeof prefix !== "string" || !prefix.trim()) return "Prefix is required";
  const normalizedPrefix = prefix.trim();
  if (/[\s/]/.test(normalizedPrefix)) {
    return "Prefix cannot contain whitespace or slashes.";
  }
  const providerId = RESERVED_PROVIDER_PREFIXES.get(normalizedPrefix);
  return providerId
    ? `Prefix "${normalizedPrefix}" is reserved for built-in provider "${providerId}". Choose a different prefix.`
    : null;
}

export function getProviderPrefixConflict(prefix, nodes, excludeNodeId = null) {
  if (typeof prefix !== "string" || !prefix.trim()) return null;
  const normalizedPrefix = prefix.trim();
  const conflict = nodes.find((node) => node.id !== excludeNodeId && (
    (typeof node.prefix === "string" && node.prefix.trim() === normalizedPrefix) || node.id === normalizedPrefix
  ));
  return conflict
    ? `Prefix "${normalizedPrefix}" is already used by provider "${conflict.name || conflict.id}". Choose a different prefix.`
    : null;
}
