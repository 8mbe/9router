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
 * membership is decided by `open-sse/services/modelMatch.js`. Known working
 * members go first, then untested members, then failed members. Match quality
 * and provider priority preserve the order inside each group.
 *
 * Failures stay in the combo so a later fallback can still recover. Health
 * ranking applies only here; explicit routes keep their configured order.
 *
 * Explicit configuration always wins: a user-defined combo or model alias with
 * this name short-circuits auto-combo entirely.
 */

import { getProviderConnections, getSettings, getModelAliases, getCustomModels } from "@/lib/localDb";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import { FREE_PROVIDERS, getProviderAlias } from "@/shared/constants/providers";
import { peekCachedUpstream } from "@/lib/modelCatalog/upstreamCache";
import { getProbeHints, partitionByProbe } from "@/lib/modelProbe/routingHints";
import { parseModel } from "open-sse/services/model.js";
import { isModelLockActive, getModelLockKey, MODEL_LOCK_ALL } from "open-sse/services/accountFallback.js";
import { allModelMatches, MATCH_TIER } from "open-sse/services/modelMatch.js";
import { getAutoComboHealth } from "open-sse/services/autoComboHealth.js";
import { AUTO_COMBO_STATUS, AUTO_COMBO_STATUS_RANK } from "open-sse/config/autoComboConstants.js";

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
    if (existing) existing.connections.push(conn);
    else byProvider.set(conn.provider, { providerId: conn.provider, conn, connections: [conn], noAuth: false });
  }

  for (const [providerId, provider] of Object.entries(FREE_PROVIDERS)) {
    if (!provider?.noAuth || byProvider.has(providerId)) continue;
    byProvider.set(providerId, { providerId, conn: null, connections: [], noAuth: true });
  }

  return [...byProvider.values()];
}

/**
 * Build the auto-combo for a bare model name.
 *
 * @param {string} modelStr - Requested model, with no provider prefix.
 * @param {object} [settings] - Pre-read settings, to avoid a second DB hit.
 * @returns {Promise<{models: string[], benched: string[], members: object[], matchTier: number}|null>}
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

  const allowFamilyMatches = config.autoComboFuzzy !== false;
  const maxTier = allowFamilyMatches ? MATCH_TIER.FAMILY : MATCH_TIER.CANONICAL;

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
  const healthContext = await loadHealthContext(config);
  const priority = Array.isArray(config.autoComboPriority) ? config.autoComboPriority : [];
  const matches = [];

  for (const { providerId, conn, connections, noAuth } of providers) {
    const alias = outputAliasFor(providerId, conn);
    const staticAlias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;

    const custom = customModels
      .filter((m) => m?.id && [alias, staticAlias, providerId].includes(m.providerAlias))
      .map((m) => String(m.id).trim())
      .filter(Boolean);

    const accountCatalogs = connections.map((account) => ({
      account,
      models: new Set([...catalogForConnection(providerId, account), ...custom]),
    }));
    const catalog = dedupe([
      ...(connections.length ? accountCatalogs.flatMap(({ models }) => [...models]) : catalogForConnection(providerId, null)),
      ...custom,
    ])
      .filter((id) => !isDisabled(disabledByAlias, alias, id) && !isDisabled(disabledByAlias, staticAlias, id));

    const priorityIndex = priority.indexOf(providerId);
    for (const match of allModelMatches(modelStr, catalog, { maxTier, allowFamilyMatches })) {
      const member = `${alias}/${match.candidate}`;
      const matchingAccounts = accountCatalogs
        .filter(({ models }) => models.has(match.candidate))
        .map(({ account }) => account);
      const metadata = {
        ...memberHealth(member, providerId, match.candidate, matchingAccounts, healthContext, noAuth),
        providerName: conn?.providerSpecificData?.nodeName || null,
      };
      matches.push({
        ...metadata,
        matchTier: match.tier,
        sort: [
          AUTO_COMBO_STATUS_RANK[metadata.status],
          match.score,
          priorityIndex === -1 ? priority.length : priorityIndex,
          noAuth ? 1 : 0,
          -connections.length,
          alias,
        ],
      });
    }
  }

  if (matches.length === 0) return null;

  matches.sort((a, b) => compareSortKeys(a.sort, b.sort));
  const seen = new Set();
  const members = matches.filter(({ member }) => {
    const key = member.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(({ sort, ...metadata }) => metadata);

  return {
    models: members.map(({ member }) => member),
    benched: members.filter(({ status }) => status === AUTO_COMBO_STATUS.NOT_WORKING).map(({ member }) => member),
    members,
    matchTier: Math.min(...members.map(({ matchTier }) => matchTier)),
  };
}

/** Health metadata for configured combo and capacity-adapter members. */
export async function inspectAutoComboMembers(memberStrings, settings = null) {
  const config = settings || await getSettings();
  const providers = await candidateProviders();
  const context = await loadHealthContext(config);
  return (memberStrings || []).map((member) => {
    const parsed = parseModel(member);
    const prefix = member.split("/")[0];
    const provider = providers.find(({ providerId, conn }) =>
      [providerId, PROVIDER_ID_TO_ALIAS[providerId], outputAliasFor(providerId, conn)].includes(prefix)
      || providerId === parsed.provider
    );
    const providerId = provider?.providerId || parsed.provider || prefix;
    const matchingAccounts = (provider?.connections || []).filter((account) =>
      catalogForConnection(providerId, account).includes(parsed.model)
    );
    return {
      ...memberHealth(member, providerId, parsed.model,
        matchingAccounts.length ? matchingAccounts : provider?.connections || [], context, provider?.noAuth),
      providerName: provider?.conn?.providerSpecificData?.nodeName || null,
    };
  });
}

async function loadHealthContext(config) {
  let hints = new Map();
  if (config.probeAwareRouting !== false) {
    try { hints = await getProbeHints(); } catch { /* Missing hints leave members untested. */ }
  }
  const live = new Map();
  const history = getAutoComboHealth().sort((a, b) => lastOutcomeAt(a) - lastOutcomeAt(b));
  for (const entry of history) {
    live.set(entry.member.toLowerCase(), entry);
    const parsed = parseModel(entry.member);
    live.set(`${parsed.provider}/${parsed.model}`.toLowerCase(), entry);
  }
  return { hints, live };
}

function memberHealth(member, providerId, modelId, connections, { live, hints }, noAuth = false) {
  const runtime = live.get(`${providerId}/${modelId}`.toLowerCase()) || live.get(member.toLowerCase());
  const base = {
    member, providerId, modelId, status: AUTO_COMBO_STATUS.UNTESTED,
    failures: 0, disabled: false, disabledUntil: null,
    lastStatus: null, lastError: null, lastFailureAt: null, lastSuccessAt: null,
  };
  if (!noAuth && !connections.length) {
    return { ...base, status: AUTO_COMBO_STATUS.NOT_WORKING, lastError: "No active provider connections", source: "connection" };
  }
  const eligible = connections.filter((connection) => !isModelLockActive(connection, modelId));
  if (connections.length && !eligible.length) {
    const disabledUntil = Math.min(...connections.map((connection) =>
      new Date(connection[getModelLockKey(modelId)] || connection[MODEL_LOCK_ALL]).getTime()
    ));
    return {
      ...base,
      ...runtime,
      member,
      status: AUTO_COMBO_STATUS.NOT_WORKING,
      disabled: true,
      disabledUntil: new Date(disabledUntil).toISOString(),
      lastError: runtime?.lastError || "All active accounts are unavailable for this model",
      source: "connection",
    };
  }
  if (runtime) return { ...base, ...runtime, member, source: "live" };

  const { working, unknown, broken } = partitionByProbe(eligible, modelId, hints);
  const status = working.length ? AUTO_COMBO_STATUS.WORKING
    : broken.length && !unknown.length ? AUTO_COMBO_STATUS.NOT_WORKING
      : AUTO_COMBO_STATUS.UNTESTED;
  const known = status === AUTO_COMBO_STATUS.WORKING ? working : broken;
  const testedAt = Math.max(0, ...known.map(({ id }) => hints.get(`${id}::${modelId}`)?.testedAt || 0));
  return {
    ...base,
    status,
    source: status === AUTO_COMBO_STATUS.UNTESTED ? null : "probe",
    lastSuccessAt: status === AUTO_COMBO_STATUS.WORKING && testedAt ? new Date(testedAt).toISOString() : null,
    lastFailureAt: status === AUTO_COMBO_STATUS.NOT_WORKING && testedAt ? new Date(testedAt).toISOString() : null,
  };
}

function lastOutcomeAt(entry) {
  return Math.max(Date.parse(entry.lastSuccessAt) || 0, Date.parse(entry.lastFailureAt) || 0);
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
