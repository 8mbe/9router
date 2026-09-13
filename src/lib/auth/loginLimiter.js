// In-memory per-IP lockout for dashboard login. Resets on process restart.
import { hasTrustedPeerHeaders } from "./trustedPeer.js";

const MAX_FAILS_BEFORE_LOCK = 5;
const LOCK_MS = 10 * 60 * 1000; // flat 10 minutes — no escalation
const FAIL_WINDOW_MS = 60 * 60 * 1000; // 1h since last fail → auto reset
const MAX_TRACKED_KEYS = 10_000; // bound the map so IP rotation cannot eat memory

// When custom-server.js is not in the request path (bare `next start` / `next dev`)
// the client IP is attacker-supplied, so each untrusted key is individually
// rotatable. Keys are still kept apart — one bad client must never lock every
// other user out of the instance — and a shared counter is the backstop against
// rotation, set high enough that ordinary mistyped passwords never reach it.
const UNTRUSTED_PREFIX = "untrusted:";
const UNTRUSTED_GLOBAL_KEY = `${UNTRUSTED_PREFIX}*`;
const UNTRUSTED_GLOBAL_MAX_FAILS = 50;

const attempts = new Map(); // key → { fails, lockUntil, lastFailAt }

function now() { return Date.now(); }

function isStale(e, t) {
  return e.lastFailAt && t - e.lastFailAt > FAIL_WINDOW_MS && (!e.lockUntil || t >= e.lockUntil);
}

function getEntry(key) {
  const e = attempts.get(key);
  if (!e) return null;
  // Auto reset if window expired and not currently locked
  if (isStale(e, now())) {
    attempts.delete(key);
    return null;
  }
  return e;
}

// Drop stale buckets, then the least-recently-active ones if still oversized.
// Locked buckets have the freshest lastFailAt, so they survive eviction.
function prune() {
  const t = now();
  for (const [key, e] of attempts) {
    if (isStale(e, t)) attempts.delete(key);
  }
  if (attempts.size <= MAX_TRACKED_KEYS) return;
  const byAge = [...attempts.entries()].sort((a, b) => a[1].lastFailAt - b[1].lastFailAt);
  for (const [key] of byAge.slice(0, attempts.size - MAX_TRACKED_KEYS)) {
    if (key !== UNTRUSTED_GLOBAL_KEY) attempts.delete(key);
  }
}

function lockRemaining(key) {
  const e = getEntry(key);
  if (!e || !e.lockUntil) return 0;
  return Math.max(0, e.lockUntil - now());
}

export function checkLock(ip) {
  let remaining = lockRemaining(ip);
  if (isUntrusted(ip)) remaining = Math.max(remaining, lockRemaining(UNTRUSTED_GLOBAL_KEY));
  if (remaining <= 0) return { locked: false };
  return { locked: true, retryAfter: Math.ceil(remaining / 1000) };
}

function bump(key, maxFails) {
  const e = getEntry(key) || { fails: 0, lockUntil: 0, lastFailAt: 0 };
  e.fails += 1;
  e.lastFailAt = now();
  if (e.fails >= maxFails) {
    e.lockUntil = now() + LOCK_MS;
    e.fails = 0;
  }
  attempts.set(key, e);
  return Math.max(0, maxFails - e.fails);
}

export function recordFail(ip) {
  prune();
  const remainingBeforeLock = bump(ip, MAX_FAILS_BEFORE_LOCK);
  if (isUntrusted(ip)) bump(UNTRUSTED_GLOBAL_KEY, UNTRUSTED_GLOBAL_MAX_FAILS);
  return { remainingBeforeLock };
}

export function recordSuccess(ip) {
  attempts.delete(ip);
  // Knowing the password already outranks the anti-rotation backstop, so clear
  // it too rather than leaving a stale count to lock the next honest attempt.
  if (isUntrusted(ip)) attempts.delete(UNTRUSTED_GLOBAL_KEY);
}

function isUntrusted(key) {
  return typeof key === "string" && key.startsWith(UNTRUSTED_PREFIX);
}

export function getClientIp(request) {
  // Trusted only when custom-server.js proves it stamped the header from the TCP socket;
  // otherwise a client could rotate the value to escape its own lockout bucket.
  if (hasTrustedPeerHeaders(request)) {
    const realIp = request.headers.get("x-9r-real-ip");
    if (realIp) return realIp;
  }
  // Behind a trusted reverse proxy that overwrites XFF with the real client IP.
  if (process.env.TRUST_PROXY === "true") {
    const xff = request.headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim();
  }
  // No proof of the peer address. Key on the client's own claim so a single
  // attacker locks out only its own bucket instead of the whole instance;
  // UNTRUSTED_GLOBAL_MAX_FAILS covers the rotation this permits.
  const claimed =
    request.headers.get("x-9r-real-ip") ||
    request.headers.get("x-real-ip") ||
    (request.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  return UNTRUSTED_PREFIX + (claimed || "unknown");
}

// "9m 30s" / "45s" — a bare "600s" reads badly for a 10-minute lock.
export function formatLockWait(seconds) {
  const total = Math.max(0, Math.ceil(Number(seconds) || 0));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  if (!mins) return `${secs}s`;
  return secs ? `${mins}m ${secs}s` : `${mins}m`;
}

export const __testing = { LOCK_MS, MAX_FAILS_BEFORE_LOCK, UNTRUSTED_GLOBAL_MAX_FAILS, reset: () => attempts.clear() };
