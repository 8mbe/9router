import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { Agent, ProxyAgent } = vi.hoisted(() => ({
  Agent: vi.fn(function Agent(options) { this.options = options; }),
  ProxyAgent: vi.fn(function ProxyAgent(options) { this.options = options; }),
}));
vi.mock("undici", () => ({ Agent, ProxyAgent }));

const targetUrl = "https://custom.example/v1/chat/completions";
const environmentProxy = "http://environment.example:8080";
const pinnedProxy = "http://account-session-opaque:password@pinned.example:8181";
let nativeFetch;

async function reloadFetch() {
  vi.resetModules();
  return (await import("../../open-sse/utils/proxyFetch.js")).proxyAwareFetch;
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
    vi.stubEnv(key, "");
  }
  nativeFetch = vi.fn(async () => new Response("ok"));
  vi.stubGlobal("fetch", nativeFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("proxy fetch module reloads", () => {
  it("keeps an explicit account proxy after reload instead of replacing it with the environment proxy", async () => {
    vi.stubEnv("HTTPS_PROXY", environmentProxy);
    const firstFetch = await reloadFetch();
    await firstFetch(targetUrl);
    expect(nativeFetch.mock.calls[0][1].dispatcher.options.uri).toBe(environmentProxy);

    const reloadedFetch = await reloadFetch();
    await reloadedFetch(targetUrl, {}, { connectionProxyEnabled: true, connectionProxyUrl: pinnedProxy, strictProxy: true });
    expect(nativeFetch).toHaveBeenCalledTimes(2);
    expect(nativeFetch.mock.calls[1][1].dispatcher.options.uri).toBe(pinnedProxy);
    expect(nativeFetch.mock.calls[1][1].dispatcher).not.toBe(nativeFetch.mock.calls[0][1].dispatcher);
  });

  it("keeps explicit pinned transport across repeated server bundle reloads", async () => {
    vi.stubEnv("HTTPS_PROXY", environmentProxy);
    for (let index = 0; index < 3; index++) {
      const proxyFetch = await reloadFetch();
      await proxyFetch(targetUrl, { method: "POST", body: "payload" }, {
        enabled: true, url: pinnedProxy, strictProxy: true,
      });
    }
    expect(nativeFetch).toHaveBeenCalledTimes(3);
    expect(nativeFetch.mock.calls.every((call) => call[1].dispatcher.options.uri === pinnedProxy)).toBe(true);
    expect(ProxyAgent.mock.calls.every((call) => call[0].uri === pinnedProxy)).toBe(true);
  });

  it("continues using the environment proxy for ordinary fetches after reload", async () => {
    vi.stubEnv("HTTPS_PROXY", environmentProxy);
    await reloadFetch();
    await reloadFetch();
    await globalThis.fetch(targetUrl);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(nativeFetch.mock.calls[0][1].dispatcher.options.uri).toBe(environmentProxy);
    expect(ProxyAgent).toHaveBeenCalledTimes(1);
  });

  it("still refuses strict proxy requests with no resolved proxy after reload", async () => {
    await reloadFetch();
    const reloadedFetch = await reloadFetch();
    await expect(reloadedFetch(targetUrl, {}, {
      connectionProxyEnabled: true, connectionProxyUrl: "", strictProxy: true,
    })).rejects.toThrow(/Proxy required but none resolved/);
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it("captures a newly installed fetch stub or instrumentation on the next load", async () => {
    const firstFetch = await reloadFetch();
    await firstFetch(targetUrl);
    const freshFetch = vi.fn(async () => new Response("instrumented"));
    vi.stubGlobal("fetch", freshFetch);
    const reloadedFetch = await reloadFetch();
    expect(await (await reloadedFetch(targetUrl)).text()).toBe("instrumented");
    expect(freshFetch).toHaveBeenCalledTimes(1);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });
});
