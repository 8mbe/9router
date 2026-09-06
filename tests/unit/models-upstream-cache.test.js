import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getCachedUpstream,
  invalidateUpstreamModels,
  upstreamCacheSize,
} from "@/lib/modelCatalog/upstreamCache";

beforeEach(() => {
  invalidateUpstreamModels();
  delete process.env.MODELS_CACHE_TTL_MS;
});

describe("upstream models cache", () => {
  it("calls the loader once and serves the cached value after", async () => {
    const loader = vi.fn(async () => ["a", "b"]);
    expect(await getCachedUpstream("k", loader)).toEqual(["a", "b"]);
    expect(await getCachedUpstream("k", loader)).toEqual(["a", "b"]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight load between concurrent callers", async () => {
    let resolve;
    const loader = vi.fn(() => new Promise((r) => { resolve = r; }));
    const a = getCachedUpstream("k", loader);
    const b = getCachedUpstream("k", loader);
    resolve(["x"]);
    expect(await a).toEqual(["x"]);
    expect(await b).toEqual(["x"]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("returns null and caches nothing when a cold load fails", async () => {
    const loader = vi.fn(async () => { throw new Error("upstream down"); });
    expect(await getCachedUpstream("k", loader)).toBeNull();
    expect(upstreamCacheSize()).toBe(0);
    // The next request retries rather than serving an empty catalog forever.
    expect(await getCachedUpstream("k", async () => ["late"])).toEqual(["late"]);
  });

  it("returns null and caches nothing when a cold load resolves empty", async () => {
    expect(await getCachedUpstream("k", async () => null)).toBeNull();
    expect(upstreamCacheSize()).toBe(0);
  });

  it("keeps serving the previous catalog when a refresh fails", async () => {
    process.env.MODELS_CACHE_TTL_MS = "0";
    expect(await getCachedUpstream("k", async () => ["first"])).toEqual(["first"]);
    // TTL 0 → the next read is stale, revalidates in the background, and the
    // failing refresh must not empty the entry.
    expect(await getCachedUpstream("k", async () => { throw new Error("down"); })).toEqual(["first"]);
    await new Promise((r) => setTimeout(r, 10));
    expect(await getCachedUpstream("k", async () => { throw new Error("down"); })).toEqual(["first"]);
  });

  it("serves stale immediately and refreshes in the background", async () => {
    process.env.MODELS_CACHE_TTL_MS = "0";
    expect(await getCachedUpstream("k", async () => ["v1"])).toEqual(["v1"]);
    // Stale hit returns the old value without waiting on the new loader...
    expect(await getCachedUpstream("k", async () => ["v2"])).toEqual(["v1"]);
    await new Promise((r) => setTimeout(r, 10));
    // ...but the background refresh has landed by the next request.
    expect(await getCachedUpstream("k", async () => ["v3"])).toEqual(["v2"]);
  });

  it("invalidates by prefix only", async () => {
    await getCachedUpstream("live:c1:kiro", async () => ["a"]);
    await getCachedUpstream("compat:c1:https://x", async () => ["b"]);
    await getCachedUpstream("live:c2:kiro", async () => ["c"]);
    invalidateUpstreamModels("live:c1:");
    expect(upstreamCacheSize()).toBe(2);
    invalidateUpstreamModels();
    expect(upstreamCacheSize()).toBe(0);
  });
});
