import { createHash, randomBytes } from "node:crypto";
import { CUSTOM_API_SESSION_CONFIG } from "../config/customApiSessionConfig.js";

// Next can load this module in multiple server bundles and during hot reload.
// Keep both the account generations and provider pins in the same shared store.
const storeKey = Symbol.for(CUSTOM_API_SESSION_CONFIG.storageKey);
const store = globalThis[storeKey] ||= { providers: new Map() };

export function isCustomApiSessionPinningEnabled(provider, providerSpecificData = {}) {
  return typeof provider === "string"
    && CUSTOM_API_SESSION_CONFIG.providerPrefixes.some((prefix) => provider.startsWith(prefix))
    && providerSpecificData?.customApiSessionPinning === true;
}

function proxyConfigError(message) {
  const error = new Error(message);
  error.code = CUSTOM_API_SESSION_CONFIG.proxyErrorCode;
  return error;
}

function decodeCredential(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw proxyConfigError("Session pinning requires valid URL-encoded proxy credentials.");
  }
}

/**
 * Set the proxy's sticky session in credentials only. The opaque ID never
 * contains an account ID, API key, client session ID, or prompt-derived value.
 *
 * Bright Data documents `-session-<alphanumeric ID>-const` here:
 * https://docs.brightdata.com/api-reference/proxy/rotate_ips
 * Other proxies must provide an explicit `{session}` credential placeholder.
 */
export function buildCustomApiSessionProxyUrl(proxyUrl, sessionId) {
  if (typeof sessionId !== "string" || !/^[a-z0-9]+$/i.test(sessionId)) {
    throw proxyConfigError("Proxy session IDs must contain alphanumeric characters only.");
  }
  if (typeof proxyUrl !== "string" || !proxyUrl.trim()) {
    throw proxyConfigError("Session pinning requires an enabled proxy.");
  }

  let parsed;
  try {
    const normalized = proxyUrl.trim();
    parsed = new URL(normalized.includes("://") ? normalized : `http://${normalized}`);
  } catch {
    throw proxyConfigError("Session pinning requires a valid proxy URL.");
  }
  if (!CUSTOM_API_SESSION_CONFIG.supportedProtocols.includes(parsed.protocol)) {
    throw proxyConfigError("Session pinning requires an HTTP or HTTPS proxy.");
  }

  const username = decodeCredential(parsed.username);
  const password = decodeCredential(parsed.password);
  const placeholder = CUSTOM_API_SESSION_CONFIG.placeholder;
  if (decodeCredential(parsed.hostname + parsed.pathname + parsed.search + parsed.hash).includes(placeholder)) {
    throw proxyConfigError("Put the {session} placeholder in the proxy username or password.");
  }

  const host = parsed.hostname.toLowerCase();
  const brightData = host === CUSTOM_API_SESSION_CONFIG.brightDataHost
    || host.endsWith(`.${CUSTOM_API_SESSION_CONFIG.brightDataHost}`);
  if (brightData) {
    if (!username) {
      throw proxyConfigError("Bright Data session pinning requires a proxy username.");
    }
    // Replace a saved session rather than appending a second session selector.
    const baseUsername = username
      .replace(/-session-[^-]+/gi, "")
      .replace(/-const(?=-|$)/gi, "")
      .replaceAll(placeholder, sessionId);
    parsed.username = encodeURIComponent(`${baseUsername}-session-${sessionId}-const`);
    parsed.password = encodeURIComponent(password.replaceAll(placeholder, sessionId));
  } else {
    if (!username.includes(placeholder) && !password.includes(placeholder)) {
      throw proxyConfigError("Session pinning requires Bright Data or a {session} placeholder in proxy credentials.");
    }
    parsed.username = encodeURIComponent(username.replaceAll(placeholder, sessionId));
    parsed.password = encodeURIComponent(password.replaceAll(placeholder, sessionId));
  }
  return parsed.toString();
}

function providerState(provider, create = false) {
  let state = store.providers.get(provider);
  if (!state && create) {
    state = { pinned: null, accounts: new Map() };
    store.providers.set(provider, state);
  }
  return state;
}

function forgetDrainedSession(provider, state, entry) {
  if (!entry.draining || entry.activeLeases > 0) return;
  // A late release from an old generation must not remove a newer generation.
  if (state.accounts.get(entry.connectionId) === entry) state.accounts.delete(entry.connectionId);
  if (state.pinned === entry) state.pinned = null;
  if (!state.accounts.size && store.providers.get(provider) === state) store.providers.delete(provider);
}

function drainSession(provider, state, entry) {
  entry.draining = true;
  if (state.pinned === entry) state.pinned = null;
  forgetDrainedSession(provider, state, entry);
}

/** Select the provider's account without creating an upstream request lease. */
export function pinCustomApiConnection(provider, connectionId) {
  if (typeof provider !== "string"
    || !CUSTOM_API_SESSION_CONFIG.providerPrefixes.some((prefix) => provider.startsWith(prefix))
    || typeof connectionId !== "string" || !connectionId) return false;
  const state = providerState(provider, true);
  let entry = state.accounts.get(connectionId);
  if (entry?.draining) return false;
  if (!entry) {
    entry = {
      connectionId,
      sessionId: randomBytes(CUSTOM_API_SESSION_CONFIG.sessionBytes).toString("hex"),
      activeLeases: 0,
      draining: false,
    };
    state.accounts.set(connectionId, entry);
  }
  state.pinned = entry;
  return true;
}

export function getPinnedCustomApiConnectionId(provider) {
  const entry = providerState(provider)?.pinned;
  return entry && !entry.draining ? entry.connectionId : null;
}

export function isCustomApiConnectionDraining(provider, connectionId) {
  return providerState(provider)?.accounts.get(connectionId)?.draining === true;
}

/** Block new requests while existing requests finish or cancel upstream. */
export function markCustomApiSessionDraining(provider, connectionId) {
  const state = providerState(provider);
  const entry = state?.accounts.get(connectionId);
  if (!entry) return false;
  drainSession(provider, state, entry);
  return true;
}

/**
 * Acquire at the outbound fetch boundary. Keep the lease until upstream
 * completes, errors, or finishes cancellation, including for streamed results.
 * Normal completion keeps the account/session pin. Draining retires that
 * generation only after its last lease releases.
 *
 * Returns null for opt-out or a draining account. Invalid proxy configuration
 * throws before a lease is created, so callers can fail without leaking state.
 */
export function acquireCustomApiSession({ provider, connectionId, providerSpecificData = {}, proxyUrl, accountFingerprint } = {}) {
  if (!isCustomApiSessionPinningEnabled(provider, providerSpecificData)) return null;
  if (typeof connectionId !== "string" || !connectionId) {
    throw proxyConfigError("Session pinning requires a selected account.");
  }
  let state = providerState(provider);
  let entry = state?.accounts.get(connectionId);
  if (entry?.draining) return null;

  let sessionId = entry?.sessionId || randomBytes(CUSTOM_API_SESSION_CONFIG.sessionBytes).toString("hex");
  let pinnedProxyUrl = buildCustomApiSessionProxyUrl(proxyUrl, sessionId);
  let proxyIdentity = createHash("sha256").update(pinnedProxyUrl).digest("hex");
  const fingerprint = typeof accountFingerprint === "string" && accountFingerprint ? accountFingerprint : null;
  const proxyChanged = entry?.proxyIdentity && entry.proxyIdentity !== proxyIdentity;
  const accountChanged = entry?.accountFingerprint && fingerprint && entry.accountFingerprint !== fingerprint;
  if (proxyChanged || accountChanged) {
    // Changed credentials, targeting, or account authentication cannot reuse a
    // live peer session. Retire the old generation before its replacement.
    drainSession(provider, state, entry);
    if (entry.activeLeases > 0) return null;
    entry = null;
    sessionId = randomBytes(CUSTOM_API_SESSION_CONFIG.sessionBytes).toString("hex");
    pinnedProxyUrl = buildCustomApiSessionProxyUrl(proxyUrl, sessionId);
    proxyIdentity = createHash("sha256").update(pinnedProxyUrl).digest("hex");
  }
  state = providerState(provider) || providerState(provider, true);
  if (!entry) {
    entry = { connectionId, sessionId, activeLeases: 0, draining: false };
    state.accounts.set(connectionId, entry);
  }
  entry.proxyIdentity = proxyIdentity;
  // Callers pass a digest, never API keys or access tokens.
  if (fingerprint) entry.accountFingerprint = fingerprint;
  entry.activeLeases += 1;
  // A delayed fetch for the previous account must not steal a newer auth pin.
  if (!state.pinned) state.pinned = entry;

  let released = false;
  return {
    sessionId,
    proxyUrl: pinnedProxyUrl,
    release() {
      if (released) return false;
      released = true;
      entry.activeLeases -= 1;
      forgetDrainedSession(provider, state, entry);
      return true;
    },
    markDraining() {
      drainSession(provider, state, entry);
    },
  };
}

/** Clear in-memory pins, intended for tests or an explicit administrative reset. */
export function clearCustomApiSessionStore() {
  store.providers.clear();
}
