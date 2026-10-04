/**
 * Health memory for auto-combo members.
 *
 * An auto-combo is assembled on the fly from every provider that carries the
 * requested model, so a provider that is failing would otherwise be retried
 * first on every single request — paying its timeout each time. This store
 * remembers the failure so working pairs can be tried first. Failed pairs stay
 * in the fallback chain, with a cooldown shown in the dashboard.
 *
 * Scope matters: this only ranks auto-combo assembly. An explicit
 * `provider/model` request, a user-defined combo, or an alias still routes to
 * the provider normally — disabling here never takes a provider away from a
 * client that asked for it by name. Account-level locks (`markAccountUnavailable`)
 * are a separate, persistent mechanism; this one is in-memory and per-process,
 * so a restart starts everyone from clean.
 */

import {
  AUTO_COMBO_COOLDOWN_LADDER_MS,
  AUTO_COMBO_HEALTH_TTL_MS,
  AUTO_COMBO_STATUS,
} from "../config/autoComboConstants.js";

/** @type {Map<string, {failures: number, disabledUntil: number, lastStatus: number|null, lastError: string|null, lastFailureAt: number, lastSuccessAt: number}>} */
const health = new Map();

function keyOf(providerModel) {
  return String(providerModel || "").trim().toLowerCase();
}

function prune(now) {
  for (const [key, entry] of health) {
    const touched = Math.max(entry.lastFailureAt || 0, entry.lastSuccessAt || 0);
    if (now - touched > AUTO_COMBO_HEALTH_TTL_MS) health.delete(key);
  }
}

/**
 * Record that a `provider/model` pair served a request successfully. Clears any
 * strike: one good response means the pair is healthy again, not merely less bad.
 */
export function markAutoComboHealthy(providerModel) {
  const key = keyOf(providerModel);
  if (!key) return;
  const now = Date.now();
  prune(now);
  const entry = health.get(key);
  if (!entry) {
    health.set(key, {
      failures: 0, disabledUntil: 0, lastStatus: null, lastError: null,
      lastFailureAt: 0, lastSuccessAt: now,
    });
    return;
  }
  entry.failures = 0;
  entry.disabledUntil = 0;
  entry.lastStatus = null;
  entry.lastError = null;
  entry.lastSuccessAt = now;
}

/**
 * Record a failure and the next cooldown step without removing the member.
 *
 * @param {string} providerModel
 * @param {number|null} status - Upstream HTTP status, when known.
 * @param {string|null} error - Error text, truncated for display.
 * @param {number|null} [resetsAtMs] - Upstream-declared reset time; when it is
 *   further out than the ladder step, it wins — no point retrying before then.
 * @returns {number} Epoch ms the pair stays disabled until.
 */
export function markAutoComboUnavailable(providerModel, status = null, error = null, resetsAtMs = null) {
  const key = keyOf(providerModel);
  if (!key) return 0;
  const now = Date.now();
  prune(now);

  const entry = health.get(key) || {
    failures: 0, disabledUntil: 0, lastStatus: null, lastError: null,
    lastFailureAt: 0, lastSuccessAt: 0,
  };
  entry.failures += 1;
  const step = AUTO_COMBO_COOLDOWN_LADDER_MS[Math.min(entry.failures - 1, AUTO_COMBO_COOLDOWN_LADDER_MS.length - 1)];
  const ladderUntil = now + step;
  entry.disabledUntil = Number.isFinite(resetsAtMs) && resetsAtMs > ladderUntil ? resetsAtMs : ladderUntil;
  entry.lastStatus = status ?? null;
  entry.lastError = error ? String(error).slice(0, 200) : null;
  entry.lastFailureAt = now;
  health.set(key, entry);
  return entry.disabledUntil;
}

/** Does this pair have an active failure cooldown? */
export function isAutoComboDisabled(providerModel) {
  prune(Date.now());
  const entry = health.get(keyOf(providerModel));
  if (!entry) return false;
  if (!entry.disabledUntil) return false;
  if (entry.disabledUntil <= Date.now()) {
    // Cooldown lapsed: the pair is eligible again, but keeps its strike count so
    // a provider that fails right back gets the next, longer step.
    entry.disabledUntil = 0;
    return false;
  }
  return true;
}

/** When this pair becomes eligible again, or 0 when it already is. */
export function autoComboDisabledUntil(providerModel) {
  prune(Date.now());
  const entry = health.get(keyOf(providerModel));
  if (!entry || !entry.disabledUntil) return 0;
  return entry.disabledUntil > Date.now() ? entry.disabledUntil : 0;
}

/**
 * Group members by their latest outcome, preserving order within each group.
 * `healthy` contains working members followed by untested members. Failed
 * members remain in `disabled` even after a cooldown lapses, until success or TTL.
 *
 * @param {string[]} members - "provider/model" strings.
 * @returns {{healthy: string[], disabled: string[]}}
 */
export function partitionByHealth(members) {
  const working = [];
  const untested = [];
  const disabled = [];
  const snapshot = new Map(getAutoComboHealth().map((entry) => [entry.member, entry]));
  for (const member of members || []) {
    const status = snapshot.get(keyOf(member))?.status;
    if (status === AUTO_COMBO_STATUS.NOT_WORKING) disabled.push(member);
    else if (status === AUTO_COMBO_STATUS.WORKING) working.push(member);
    else untested.push(member);
  }
  return { healthy: [...working, ...untested], disabled, working, untested };
}

/** Current state for routing and the dashboard, sorted by member id. */
export function getAutoComboHealth() {
  const now = Date.now();
  prune(now);
  return [...health.entries()]
    .map(([member, entry]) => ({
      member,
      status: entry.failures > 0 ? AUTO_COMBO_STATUS.NOT_WORKING : AUTO_COMBO_STATUS.WORKING,
      failures: entry.failures,
      disabled: entry.disabledUntil > now,
      disabledUntil: entry.disabledUntil > now ? new Date(entry.disabledUntil).toISOString() : null,
      lastStatus: entry.lastStatus,
      lastError: entry.lastError,
      lastFailureAt: entry.lastFailureAt ? new Date(entry.lastFailureAt).toISOString() : null,
      lastSuccessAt: entry.lastSuccessAt ? new Date(entry.lastSuccessAt).toISOString() : null,
    }))
    .sort((a, b) => String(a.member).localeCompare(String(b.member)));
}

/**
 * Clear benched state.
 * @param {string} [providerModel] - One pair; omit to clear all.
 */
export function resetAutoComboHealth(providerModel) {
  if (providerModel) health.delete(keyOf(providerModel));
  else health.clear();
}
