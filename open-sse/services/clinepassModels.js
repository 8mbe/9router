import {
  CLINE_MODELS_ENDPOINT,
  fetchClineCatalog,
  isClineFreeBundleModelId,
  isClinePassModelId,
  toModelEntries,
} from "../shared/clineModelCatalog.js";

// ClinePass connections see their paid bundle plus any Cline-namespaced free
// models the account is entitled to. OpenRouter-style `:free` ids belong to the
// dedicated `cline-free` provider, so they are deliberately not pulled in here —
// a ClinePass catalog stays a ClinePass catalog.
const isClinepassCatalogModel = (id) =>
  isClinePassModelId(id) || isClineFreeBundleModelId(id);

/**
 * Fetch ClinePass live model catalog from Cline's /models endpoint.
 *
 * @param {object} credentials - Connection credentials ({ accessToken, apiKey })
 * @returns {Promise<{ models: { id: string, name: string }[] } | null>}
 */
export async function resolveClinepassModels(credentials) {
  const rawList = await fetchClineCatalog(CLINE_MODELS_ENDPOINT, credentials);
  const models = toModelEntries(rawList, isClinepassCatalogModel);
  return models.length ? { models } : null;
}
