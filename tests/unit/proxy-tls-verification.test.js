import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { Agent, ProxyAgent } = vi.hoisted(() => ({
  Agent: vi.fn(function Agent(options) { this.options = options; }),
  ProxyAgent: vi.fn(function ProxyAgent(options) { this.options = options; }),
}));

vi.mock("undici", () => ({ Agent, ProxyAgent }));

const targetUrl = "https://provider.test/v1/chat";
const proxyUrl = "http://proxy.test:3128";
const routes = [
  { name: "direct", proxyOptions: null },
  { name: "proxy", proxyOptions: { enabled: true, url: proxyUrl, strictProxy: true } },
];

function certError(code = "SELF_SIGNED_CERT_IN_CHAIN") {
  return new TypeError("certificate verification failed", { cause: { code } });
}

async function loadFetch(fetchMock, strictSsl) {
  vi.resetModules();
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
    vi.stubEnv(key, "");
  }
  vi.stubEnv("STRICT_SSL", strictSsl);
  vi.stubGlobal("fetch", fetchMock);
  return (await import("../../open-sse/utils/proxyFetch.js")).proxyAwareFetch;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe.each(routes)("$name TLS verification", ({ name, proxyOptions }) => {
  it.each([undefined, "true", "1", "", "unexpected"])("rejects certificate errors with STRICT_SSL=%s", async (strictSsl) => {
    const error = certError();
    const fetchMock = vi.fn().mockRejectedValue(error);
    const proxyAwareFetch = await loadFetch(fetchMock, strictSsl);

    await expect(proxyAwareFetch(targetUrl, {}, proxyOptions)).rejects.toThrow("certificate verification failed");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Agent).not.toHaveBeenCalled();
    if (name === "proxy") {
      expect(ProxyAgent).toHaveBeenCalledExactlyOnceWith({ uri: proxyUrl });
    } else {
      expect(ProxyAgent).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls[0][1].dispatcher).toBeUndefined();
    }
  });

  it.each(["false", "0"])("retries certificate errors only with explicit STRICT_SSL=%s", async (strictSsl) => {
    const response = new Response("ok");
    const fetchMock = vi.fn().mockRejectedValueOnce(certError()).mockResolvedValueOnce(response);
    const proxyAwareFetch = await loadFetch(fetchMock, strictSsl);
    const options = { method: "POST", body: "payload" };

    await expect(proxyAwareFetch(targetUrl, options, proxyOptions)).resolves.toBe(response);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryOptions = fetchMock.mock.calls[1][1];
    expect(retryOptions).toMatchObject(options);
    if (name === "proxy") {
      expect(ProxyAgent).toHaveBeenNthCalledWith(1, { uri: proxyUrl });
      expect(ProxyAgent).toHaveBeenNthCalledWith(2, { uri: proxyUrl, requestTls: { rejectUnauthorized: false } });
      expect(retryOptions.dispatcher).toBe(ProxyAgent.mock.instances[1]);
      expect(Agent).not.toHaveBeenCalled();
    } else {
      expect(Agent).toHaveBeenCalledExactlyOnceWith({ connect: { rejectUnauthorized: false } });
      expect(retryOptions.dispatcher).toBe(Agent.mock.instances[0]);
      expect(ProxyAgent).not.toHaveBeenCalled();
    }
  });

  it.each([undefined, "false", "0"])("does not retry ordinary networking errors with STRICT_SSL=%s", async (strictSsl) => {
    const error = new TypeError("connection refused", { cause: { code: "ECONNREFUSED" } });
    const fetchMock = vi.fn().mockRejectedValue(error);
    const proxyAwareFetch = await loadFetch(fetchMock, strictSsl);

    await expect(proxyAwareFetch(targetUrl, {}, proxyOptions)).rejects.toThrow("connection refused");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Agent).not.toHaveBeenCalled();
    expect(ProxyAgent).toHaveBeenCalledTimes(name === "proxy" ? 1 : 0);
  });

  it("does not retry a locked request stream", async () => {
    const body = new ReadableStream();
    const reader = body.getReader();
    const fetchMock = vi.fn().mockRejectedValue(certError());
    const proxyAwareFetch = await loadFetch(fetchMock, "false");

    try {
      await expect(proxyAwareFetch(targetUrl, { body, duplex: "half" }, proxyOptions)).rejects.toThrow("certificate verification failed");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(Agent).not.toHaveBeenCalled();
      expect(ProxyAgent).toHaveBeenCalledTimes(name === "proxy" ? 1 : 0);
    } finally {
      reader.releaseLock();
    }
  });
});

describe("non-strict proxy fallback", () => {
  it.each([undefined, "false"])("preserves direct fallback for ordinary proxy failures with STRICT_SSL=%s", async (strictSsl) => {
    const response = new Response("ok");
    const error = new TypeError("connection refused", { cause: { code: "ECONNREFUSED" } });
    const fetchMock = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(response);
    const proxyAwareFetch = await loadFetch(fetchMock, strictSsl);

    await expect(proxyAwareFetch(targetUrl, {}, { enabled: true, url: proxyUrl })).resolves.toBe(response);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].dispatcher).toBe(ProxyAgent.mock.instances[0]);
    expect(fetchMock.mock.calls[1][1].dispatcher).toBeUndefined();
    expect(Agent).not.toHaveBeenCalled();
    expect(ProxyAgent).toHaveBeenCalledExactlyOnceWith({ uri: proxyUrl });
  });
});
