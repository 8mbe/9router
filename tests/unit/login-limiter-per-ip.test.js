// A failed password must lock only the offending IP, for a flat 10 minutes —
// it used to lock one shared bucket (whole instance) and escalate up to 30m.
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

const { checkLock, recordFail, recordSuccess, formatLockWait, __testing } =
  await import("../../src/lib/auth/loginLimiter.js");

const { MAX_FAILS_BEFORE_LOCK, LOCK_MS, UNTRUSTED_GLOBAL_MAX_FAILS } = __testing;

function failTimes(ip, n) {
  for (let i = 0; i < n; i++) recordFail(ip);
}

describe("login limiter lockout", () => {
  beforeEach(() => {
    __testing.reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("locks the offending IP and leaves every other IP able to log in", () => {
    failTimes("203.0.113.5", MAX_FAILS_BEFORE_LOCK);

    expect(checkLock("203.0.113.5").locked).toBe(true);
    expect(checkLock("198.51.100.9").locked).toBe(false);
    expect(checkLock("127.0.0.1").locked).toBe(false);
  });

  it("locks for a flat 10 minutes and does not escalate on the next round", () => {
    failTimes("203.0.113.5", MAX_FAILS_BEFORE_LOCK);
    expect(checkLock("203.0.113.5").retryAfter).toBe(LOCK_MS / 1000);

    vi.advanceTimersByTime(LOCK_MS);
    expect(checkLock("203.0.113.5").locked).toBe(false);

    failTimes("203.0.113.5", MAX_FAILS_BEFORE_LOCK);
    expect(checkLock("203.0.113.5").retryAfter).toBe(LOCK_MS / 1000);
  });

  it("clears the lock counter on a successful login", () => {
    failTimes("203.0.113.5", MAX_FAILS_BEFORE_LOCK - 1);
    recordSuccess("203.0.113.5");
    failTimes("203.0.113.5", MAX_FAILS_BEFORE_LOCK - 1);

    expect(checkLock("203.0.113.5").locked).toBe(false);
  });

  it("reports the attempts left before the lock trips", () => {
    expect(recordFail("203.0.113.5").remainingBeforeLock).toBe(MAX_FAILS_BEFORE_LOCK - 1);
    expect(recordFail("203.0.113.5").remainingBeforeLock).toBe(MAX_FAILS_BEFORE_LOCK - 2);
  });

  // Without custom-server.js the IP is client-supplied; individual buckets keep
  // one attacker from locking everyone out, and the shared counter is the
  // backstop against an attacker rotating the header to dodge its own bucket.
  it("does not let a few untrusted failures lock other untrusted clients", () => {
    failTimes("untrusted:1.1.1.1", MAX_FAILS_BEFORE_LOCK);

    expect(checkLock("untrusted:1.1.1.1").locked).toBe(true);
    expect(checkLock("untrusted:2.2.2.2").locked).toBe(false);
  });

  it("trips the shared backstop once untrusted failures reach abuse volume", () => {
    for (let i = 0; i < UNTRUSTED_GLOBAL_MAX_FAILS; i++) recordFail(`untrusted:10.0.0.${i}`);

    expect(checkLock("untrusted:198.51.100.9").locked).toBe(true);
    // A proven peer IP is never caught by the untrusted backstop.
    expect(checkLock("198.51.100.9").locked).toBe(false);
  });

  it("releases the shared backstop after the same 10 minutes", () => {
    for (let i = 0; i < UNTRUSTED_GLOBAL_MAX_FAILS; i++) recordFail(`untrusted:10.0.0.${i}`);
    vi.advanceTimersByTime(LOCK_MS);

    expect(checkLock("untrusted:198.51.100.9").locked).toBe(false);
  });
});

describe("formatLockWait", () => {
  it.each([
    [600, "10m"],
    [570, "9m 30s"],
    [45, "45s"],
    [0, "0s"],
  ])("renders %ss as %s", (seconds, expected) => {
    expect(formatLockWait(seconds)).toBe(expected);
  });
});
