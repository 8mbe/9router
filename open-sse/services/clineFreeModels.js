import {
  CLINE_FREE_MODELS_ENDPOINT,
  CLINE_MODELS_ENDPOINT,
  fetchClineCatalog,
  isClineFreeModelId,
  toModelEntries,
} from "../shared/clineModelCatalog.js";

/**
 * Resolve the live Cline free-tier catalog.
 *
 * Two sources, in order:
 *  1. `/models/free` — Cline's dedicated free listing. Already scoped, so every
 *     entry is kept regardless of id shape.
 *  2. `/models` filtered to free-looking ids (`cline-free/*`, `*:free`) — used
 *     when `/models/free` is unavailable on the account or errors out.
 *
 * @param {object} credentials - Connection credentials ({ accessToken, apiKey })
 * @returns {Promise<{ models: { id: string, name: string }[] } | null>}
 */
export async function resolveClineFreeModels(credentials) {
  const free = await fetchClineCatalog(CLINE_FREE_MODELS_ENDPOINT, credentials);
  const scoped = toModelEntries(free, () => true);
  if (scoped.length) return { models: scoped };

  const full = await fetchClineCatalog(CLINE_MODELS_ENDPOINT, credentials);
  const filtered = toModelEntries(full, isClineFreeModelId);
  return filtered.length ? { models: filtered } : null;
}
