import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireCustomApiSession,
  buildCustomApiSessionProxyUrl,
  clearCustomApiSessionStore,
  getPinnedCustomApiConnectionId,
  isCustomApiConnectionDraining,
  isCustomApiSessionPinningEnabled,
  markCustomApiSessionDraining,
  pinCustomApiConnection,
} from "../../open-sse/utils/customApiSession.js";

const provider = "openai-compatible-test";
const proxyUrl = "http://brd-customer-c-zone-z:secret@brd.superproxy.io:33335";
const enabled = { customApiSessionPinning: true };

function acquire(connectionId, overrides = {}) {
  return acquireCustomApiSession({ provider, connectionId, proxyUrl, providerSpecificData: enabled, ...overrides });
}

beforeEach(() => {
  clearCustomApiSessionStore();
});

describe("custom API proxy session credentials", () => {
  it("adds an opaque Bright Data session and disables peer rotation", () => {
    const lease = acquire("account-id-must-stay-private");
    const parsed = new URL(lease.proxyUrl);
    expect(lease.sessionId).toMatch(/^[0-9a-f]{32}$/);
    expect(decodeURIComponent(parsed.username)).toBe(`brd-customer-c-zone-z-session-${lease.sessionId}-const`);
    expect(parsed.password).toBe("secret");
    expect(lease.proxyUrl).not.toContain("account-id-must-stay-private");
    lease.release();
  });

  it("replaces an existing Bright Data session and keeps targeting parameters", () => {
    const pinned = buildCustomApiSessionProxyUrl(
      "http://brd-customer-c-zone-z-session-old123-country-us-const:secret%3Awith%40punctuation@brd.superproxy.io:33335",
      "new123",
    );
    const parsed = new URL(pinned);
    expect(decodeURIComponent(parsed.username)).toBe("brd-customer-c-zone-z-country-us-session-new123-const");
    expect(decodeURIComponent(parsed.password)).toBe("secret:with@punctuation");
  });

  it("accepts a country superproxy hostname", () => {
    const pinned = new URL(buildCustomApiSessionProxyUrl(
      "http://user:secret@us.brd.superproxy.io:33335", "abc123",
    ));
    expect(pinned.username).toBe("user-session-abc123-const");
  });

  it("substitutes raw or encoded placeholders in generic proxy credentials", () => {
    const raw = buildCustomApiSessionProxyUrl("http://user-session-{session}:secret-{session}@proxy.example:8080", "abc123");
    const encoded = buildCustomApiSessionProxyUrl("http://user-session-%7Bsession%7D:secret-%7Bsession%7D@proxy.example:8080", "abc123");
    expect(raw).toBe(encoded);
    const parsed = new URL(raw);
    expect(parsed.username).toBe("user-session-abc123");
    expect(parsed.password).toBe("secret-abc123");
  });

  it("accepts a password-only generic session placeholder", () => {
    const parsed = new URL(buildCustomApiSessionProxyUrl("http://user:secret-{session}@proxy.example:8080", "abc123"));
    expect(parsed.password).toBe("secret-abc123");
  });

  it.each([
    "",
    "http://user:TOPSECRET@proxy.example:8080",
    "http://brd.superproxy.io:33335",
    "ftp://user-{session}:TOPSECRET@proxy.example:8080",
    "socks5://user-{session}:TOPSECRET@proxy.example:1080",
    "http://user:TOPSECRET@proxy.example:8080/?session={session}",
    "http://user:TOPSECRET@proxy.example:8080/?session=%7Bsession%7D",
    "http://user:TOPSECRET@proxy.example:8080/{session}",
    "http://%ZZ:TOPSECRET@brd.superproxy.io:33335",
  ])("fails closed without exposing credentials for unsupported URL %s", (url) => {
    let error;
    try { buildCustomApiSessionProxyUrl(url, "abc123"); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("CUSTOM_API_SESSION_PROXY_INVALID");
    expect(error.message).not.toContain("TOPSECRET");
  });

  it("rejects invalid session IDs", () => {
    expect(() => buildCustomApiSessionProxyUrl(proxyUrl, "client-session")).toThrow(/alphanumeric/);
  });

  it("does not acquire or create a pin when proxy validation fails", () => {
    expect(() => acquire("a", { proxyUrl: "" })).toThrow(/enabled proxy/);
    expect(getPinnedCustomApiConnectionId(provider)).toBeNull();
    expect(markCustomApiSessionDraining(provider, "a")).toBe(false);
  });
});

describe("custom API account pin and draining lifecycle", () => {
  it.each(["openai-compatible-a", "anthropic-compatible-a", "custom-embedding-a"])("requires opt-in for %s", (id) => {
    expect(isCustomApiSessionPinningEnabled(id, enabled)).toBe(true);
    expect(isCustomApiSessionPinningEnabled(id, {})).toBe(false);
    expect(isCustomApiSessionPinningEnabled(id, { customApiSessionPinning: "true" })).toBe(false);
  });

  it("does not pin first-party accounts or opted-out custom accounts", () => {
    expect(isCustomApiSessionPinningEnabled("openai", enabled)).toBe(false);
    expect(pinCustomApiConnection("openai", "a")).toBe(false);
    expect(acquire("a", { providerSpecificData: {} })).toBeNull();
    expect(acquire("a", { provider: "openai" })).toBeNull();
    expect(getPinnedCustomApiConnectionId(provider)).toBeNull();
  });

  it("pins immediately during account selection without acquiring a lease", () => {
    expect(pinCustomApiConnection(provider, "a")).toBe(true);
    expect(getPinnedCustomApiConnectionId(provider)).toBe("a");
    expect(markCustomApiSessionDraining(provider, "a")).toBe(true);
    expect(isCustomApiConnectionDraining(provider, "a")).toBe(false);
    expect(getPinnedCustomApiConnectionId(provider)).toBeNull();
  });

  it("retains the same proxy session after normal response completion", () => {
    const first = acquire("a");
    expect(first.release()).toBe(true);
    expect(first.release()).toBe(false);
    const second = acquire("a");
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.proxyUrl).toBe(first.proxyUrl);
    expect(getPinnedCustomApiConnectionId(provider)).toBe("a");
    second.release();
  });

  it("never shares a proxy session across accounts or custom providers", () => {
    const a = acquire("a");
    const b = acquire("b");
    const otherProvider = acquire("a", { provider: "anthropic-compatible-test" });
    expect(new Set([a.sessionId, b.sessionId, otherProvider.sessionId]).size).toBe(3);
    a.release();
    b.release();
    otherProvider.release();
  });

  it("blocks all new requests on a draining account until every concurrent lease ends", () => {
    const a1 = acquire("a");
    const a2 = acquire("a");
    expect(a1.sessionId).toBe(a2.sessionId);
    markCustomApiSessionDraining(provider, "a");
    expect(getPinnedCustomApiConnectionId(provider)).toBeNull();
    expect(isCustomApiConnectionDraining(provider, "a")).toBe(true);
    expect(pinCustomApiConnection(provider, "a")).toBe(false);
    expect(acquire("a")).toBeNull();

    const b = acquire("b");
    expect(b.sessionId).not.toBe(a1.sessionId);
    expect(getPinnedCustomApiConnectionId(provider)).toBe("b");
    a1.release();
    a1.release();
    expect(isCustomApiConnectionDraining(provider, "a")).toBe(true);
    expect(acquire("a")).toBeNull();
    a2.release();
    expect(isCustomApiConnectionDraining(provider, "a")).toBe(false);
    expect(getPinnedCustomApiConnectionId(provider)).toBe("b");

    const freshA = acquire("a");
    expect(freshA.sessionId).not.toBe(a1.sessionId);
    expect(freshA.sessionId).not.toBe(b.sessionId);
    freshA.release();
    b.release();
  });

  it("does not let a delayed fetch or repeated old-generation drain steal the new pin", () => {
    const old = acquire("a");
    pinCustomApiConnection(provider, "b");
    const delayed = acquire("a");
    expect(getPinnedCustomApiConnectionId(provider)).toBe("b");
    old.markDraining();
    old.release();
    delayed.release();
    const fresh = acquire("a");
    old.markDraining();
    expect(isCustomApiConnectionDraining(provider, "a")).toBe(false);
    expect(getPinnedCustomApiConnectionId(provider)).toBe("b");
    fresh.release();
  });

  it("retires an idle drained session before reuse", () => {
    const first = acquire("a");
    first.release();
    markCustomApiSessionDraining(provider, "a");
    const second = acquire("a");
    expect(second.sessionId).not.toBe(first.sessionId);
    second.release();
  });

  it("waits for active streams to drain before changing proxy credentials", () => {
    const old = acquire("a");
    const changedProxy = proxyUrl.replace("secret", "changed-secret");
    expect(acquire("a", { proxyUrl: changedProxy })).toBeNull();
    expect(isCustomApiConnectionDraining(provider, "a")).toBe(true);
    expect(acquire("a", { proxyUrl: changedProxy })).toBeNull();
    old.release();
    const fresh = acquire("a", { proxyUrl: changedProxy });
    expect(fresh.sessionId).not.toBe(old.sessionId);
    expect(new URL(fresh.proxyUrl).password).toBe("changed-secret");
    fresh.release();
  });

  it("starts a new proxy session immediately for a reconfigured idle account", () => {
    const old = acquire("a");
    old.release();
    const fresh = acquire("a", { proxyUrl: proxyUrl.replace("secret", "new-secret") });
    expect(fresh.sessionId).not.toBe(old.sessionId);
    expect(getPinnedCustomApiConnectionId(provider)).toBe("a");
    fresh.release();
  });

  it("waits for old account authentication to drain when a connection's API key changes", () => {
    const oldFingerprint = createHash("sha256").update("old account key").digest("hex");
    const newFingerprint = createHash("sha256").update("new account key").digest("hex");
    const old = acquire("a", { accountFingerprint: oldFingerprint });
    expect(pinCustomApiConnection(provider, "a")).toBe(true);
    expect(acquire("a", { accountFingerprint: newFingerprint })).toBeNull();
    expect(isCustomApiConnectionDraining(provider, "a")).toBe(true);
    old.release();
    const fresh = acquire("a", { accountFingerprint: newFingerprint });
    expect(fresh.sessionId).not.toBe(old.sessionId);
    fresh.release();
  });

  it("rotates an idle connection's session when account authentication changes", () => {
    const oldFingerprint = createHash("sha256").update("old account key").digest("hex");
    const newFingerprint = createHash("sha256").update("new account key").digest("hex");
    const old = acquire("a", { accountFingerprint: oldFingerprint });
    old.release();
    const fresh = acquire("a", { accountFingerprint: newFingerprint });
    expect(fresh.sessionId).not.toBe(old.sessionId);
    fresh.release();
  });

  it("shares live leases and pins across module reloads", async () => {
    const first = acquire("a");
    vi.resetModules();
    const reloaded = await import("../../open-sse/utils/customApiSession.js");
    expect(reloaded.getPinnedCustomApiConnectionId(provider)).toBe("a");
    const second = reloaded.acquireCustomApiSession({ provider, connectionId: "a", proxyUrl, providerSpecificData: enabled });
    expect(second.sessionId).toBe(first.sessionId);
    reloaded.markCustomApiSessionDraining(provider, "a");
    first.release();
    expect(reloaded.isCustomApiConnectionDraining(provider, "a")).toBe(true);
    second.release();
    expect(reloaded.isCustomApiConnectionDraining(provider, "a")).toBe(false);
  });
});
