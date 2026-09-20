/**
 * Auto-combos: a bare model name routed across every provider that has it.
 *
 * A client that sends `gpt-5.6-sol` (rather than `someprovider/gpt-5.6-sol`)
 * is naming a model, not a provider. If three connected accounts all carry that
 * model, there is no reason the request should live or die with whichever one
 * the name-prefix heuristic happens to guess. So a bare name is assembled into
 * a combo on the fly — the same fallback machinery user-defined combos use —
 * and each provider is tried in turn until one answers.
 *
 * Provider spellings differ (`gpt-5-6-sol`, `gpt-5.6-sol-latest`, `…-solm`), so
 * membership is decided by `open-sse/services/modelMatch.js` rather than string
 * equality, and members are ordered by how exact the match was: an exact hit is
 * always tried before a fuzzy one.
 *
 * Failing members are benched in `autoComboHealth` so the next request skips
 * them instead of paying their timeout again. That bench applies ONLY here —
 * `provider/model`, aliases and user-defined combos are untouched.
 *
 * Explicit configuration always wins: a user-defined combo or model alias with
 * this name short-circuits auto-combo entirely.
 */

import { getProviderConnections, getSettings, getModelAliases, getCustomModels } from "@/lib/localDb";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import { FREE_PROVIDERS, getProviderAlias } from "@/shared/constants/providers";
import { peekCachedUpstream } from "@/lib/modelCatalog/upstreamCache";
import { bestModelMatch, MATCH_TIER } from "open-sse/services/modelMatch.js";
import { partitionByHealth } from "open-sse/services/autoComboHealth.js";

// Cap on members. Past a handful, another provider is far more likely to add
// latency to a doomed request than to be the one that finally answers.
const DEFAULT_MAX_MEMBERS = 8;

/** Model-id catalog for one provider account, cheapest source first. */
function catalogForConnection(providerId, conn) {
  // A pinned list is the account's own answer about what it serves.
  const enabled = conn?.providerSpecificData?.enabledModels;
  if (Array.isArray(enabled) && enabled.length > 0) {
    return enabled.filter((m) => typeof m === "string" && m.trim());
  }

  // Warm upstream catalogs only — never a blocking fetch on the chat path.
  // Keys mirror the ones /v1/models writes (see resolveUpstreamCatalog).
  if (conn?.id) {
    const live = peekCachedUpstream(`live:${conn.id}:${providerId}`);
    if (Array.isArray(live) && live.length > 0) {
      return live.map((m) => m?.id).filter((id) => typeof id === "string" && id.trim());
    }
    const baseUrl = typeof conn?.providerSpecificData?.baseUrl === "string"
      ? conn.providerSpecificData.baseUrl.trim().replace(/\/$/, "")
      : "";
    const compat = peekCachedUpstream(`compat:${conn.id}:${baseUrl}`);
    if (Array.isArray(compat) && compat.length > 0) {
      return compat.filter((id) => typeof id === "string" && id.trim());
    }
  }

  const staticAlias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
  return (PROVIDER_MODELS[staticAlias] || []).map((m) => m.id).filter(Boolean);
}

/** The prefix this provider's models are addressed by (`alias/model`). */
function outputAliasFor(providerId, conn) {
  return String(
    conn?.providerSpecificData?.prefix
    || getProviderAlias(providerId)
    || PROVIDER_ID_TO_ALIAS[providerId]
    || providerId
  ).trim();
}

/**
 * Candidate providers: one entry per provider with at least one active
 * connection, plus the no-auth free providers, which need no account to work.
 */
async function candidateProviders() {
  let connections = [];
  try {
    connections = (await getProviderConnections({ isActive: true })) || [];
  } catch {
    connections = [];
  }

  // getProviderConnections is sorted by priority, so the first connection seen
  // for a provider is also the account that provider would route to first.
  const byProvider = new Map();
  for (const conn of connections) {
    if (!conn?.provider) continue;
    const existing = byProvider.get(conn.provider);
    if (existing) existing.accounts += 1;
    else byProvider.set(conn.provider, { providerId: conn.provider, conn, accounts: 1, noAuth: false });
  }

  for (const [providerId, provider] of Object.entries(FREE_PROVIDERS)) {
    if (!provider?.noAuth || byProvider.has(providerId)) continue;
    byProvider.set(providerId, { providerId, conn: null, accounts: 1, noAuth: true });
  }

  return [...byProvider.values()];
}

/**
 * Build the auto-combo for a bare model name.
 *
 * @param {string} modelStr - Requested model, with no provider prefix.
 * @param {object} [settings] - Pre-read settings, to avoid a second DB hit.
 * @returns {Promise<{models: string[], benched: string[], matchTier: number}|null>}
 *   null when auto-combo does not apply (disabled, prefixed name, explicit
 *   alias, or no provider carries the model).
 */
export async function resolveAutoCombo(modelStr, settings = null) {
  if (!modelStr || modelStr.includes("/")) return null;

  const config = settings || (await getSettings());
  if (config.autoComboEnabled === false) return null;

  // An alias is the user saying where this name goes. Respect it.
  try {
    const aliases = await getModelAliases();
    if (aliases && aliases[modelStr]) return null;
  } catch {
    // Alias lookup failing is not a reason to skip routing.
  }

  const maxTier = config.autoComboFuzzy === false ? MATCH_TIER.CANONICAL : MATCH_TIER.NEAR;
  const maxMembers = Number.isFinite(config.autoComboMaxMembers) && config.autoComboMaxMembers > 0
    ? config.autoComboMaxMembers
    : DEFAULT_MAX_MEMBERS;

  let disabledByAlias = {};
  try {
    disabledByAlias = (await getDisabledModels()) || {};
  } catch {
    disabledByAlias = {};
  }

  let customModels = [];
  try {
    customModels = (await getCustomModels()) || [];
  } catch {
    customModels = [];
  }

  const providers = await candidateProviders();
  const priority = Array.isArray(config.autoComboPriority) ? config.autoComboPriority : [];
  const matches = [];

  for (const { providerId, conn, accounts, noAuth } of providers) {
    const alias = outputAliasFor(providerId, conn);
    const staticAlias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;

    const custom = customModels
      .filter((m) => m?.id && [alias, staticAlias, providerId].includes(m.providerAlias))
      .map((m) => String(m.id).trim())
      .filter(Boolean);

    const catalog = [...new Set([...catalogForConnection(providerId, conn), ...custom])]
      .filter((id) => !isDisabled(disabledByAlias, alias, id) && !isDisabled(disabledByAlias, staticAlias, id));

    const match = bestModelMatch(modelStr, catalog, { maxTier });
    if (!match) continue;

    const priorityIndex = priority.indexOf(providerId);
    matches.push({
      member: `${alias}/${match.candidate}`,
      tier: match.tier,
      // Sort key, in order: match quality, explicit priority, credentialed
      // before public, more accounts before fewer.
      sort: [
        match.score,
        priorityIndex === -1 ? priority.length : priorityIndex,
        noAuth ? 1 : 0,
        -accounts,
        alias,
      ],
    });
  }

  if (matches.length === 0) return null;

  matches.sort((a, b) => compareSortKeys(a.sort, b.sort));
  const ranked = dedupe(matches.map((m) => m.member)).slice(0, maxMembers);

  // Benched members are dropped, not reordered — that is what disabling means.
  // But if everything is benched we still try, soonest-eligible first: the user
  // asked for the model, and a stale cooldown is no reason to refuse outright.
  const { healthy, disabled } = partitionByHealth(ranked);
  const models = healthy.length > 0 ? healthy : disabled;

  return {
    models,
    benched: healthy.length > 0 ? disabled : [],
    matchTier: matches[0].tier,
  };
}

function isDisabled(disabledByAlias, alias, modelId) {
  const list = disabledByAlias?.[alias];
  return Array.isArray(list) && list.includes(modelId);
}

function compareSortKeys(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
