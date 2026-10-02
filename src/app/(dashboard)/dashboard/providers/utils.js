import { getModelKind, getModelsByProviderId } from "@/shared/constants/models";
import { getProviderAlias } from "@/shared/constants/providers";

export function matchesProviderSearch(
  searchQuery,
  providerId,
  provider,
  { customModels = [], modelAliases = {} } = {},
) {
  const query = searchQuery.trim().toLowerCase();
  if (!query) return true;

  const matches = (...fields) =>
    fields.some(
      (field) => typeof field === "string" && field.toLowerCase().includes(query),
    );
  const providerAlias = getProviderAlias(providerId);
  const displayAlias = provider.prefix || providerAlias;
  if (matches(provider.name, providerId, providerAlias, displayAlias)) return true;

  const storageAliases = new Set([providerId, providerAlias]);
  const models = [
    ...getModelsByProviderId(providerId),
    ...customModels.filter((model) => storageAliases.has(model.providerAlias)),
  ];
  const matchesModel = (model) =>
    matches(
      model.id,
      model.name,
      model.alias,
      `${providerAlias}/${model.id}`,
      `${providerId}/${model.id}`,
      `${displayAlias}/${model.id}`,
    );

  if (
    models.some(
      (model) => getModelKind(model, "llm") === "llm" && matchesModel(model),
    )
  ) return true;

  return Object.entries(modelAliases).some(([alias, fullModel]) => {
    if (typeof fullModel !== "string") return false;
    const separator = fullModel.indexOf("/");
    if (separator <= 0) return false;
    if (!storageAliases.has(fullModel.slice(0, separator))) return false;
    const id = fullModel.slice(separator + 1);
    if (!id) return false;

    const knownModels = models.filter((model) => model.id === id);
    if (
      knownModels.length > 0 &&
      knownModels.every((model) => getModelKind(model, "llm") !== "llm")
    ) return false;

    return matchesModel({ id, alias });
  });
}

export const STATUS_FILTER_OPTIONS = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "none", label: "No connection" },
];

// noAuth providers (e.g. free proxies) are always usable even though they
// never have a stored connection record, so they never fall into "none".
export function getConnectionStatus(stats, isNoAuth = false) {
  if (isNoAuth) return "active";
  if (!stats || stats.total === 0) return "none";
  return stats.allDisabled ? "inactive" : "active";
}

export function matchesStatusFilter(statusFilter, stats, isNoAuth = false) {
  if (statusFilter === "all") return true;
  return getConnectionStatus(stats, isNoAuth) === statusFilter;
}
