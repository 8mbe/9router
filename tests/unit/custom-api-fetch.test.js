import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { fetchCustomApi } from "../../open-sse/utils/customApiFetch.js";
import {
  clearCustomApiSessionStore,
  getPinnedCustomApiConnectionId,
  isCustomApiConnectionDraining,
  markCustomApiSessionDraining,
  pinCustomApiConnection,
} from "../../open-sse/utils/customApiSession.js";

const provider = "openai-compatible-transport";
const proxyUrl = "http://brd-customer-c-zone-z:secret@brd.superproxy.io:33335";
const url = "https://upstream.example/v1/chat/completions";
const encoder = new TextEncoder();

function credentials(connectionId = "a", overrides = {}) {
  return {
    connectionId,
    providerSpecificData: {
      customApiSessionPinning: true,
      connectionProxyEnabled: true,
      connectionProxyUrl: proxyUrl,
      ...overrides,
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((value) => { resolve = value; });
  return { promise, resolve };
}

function controlledResponse(cancel = vi.fn()) {
  let controller;
  const body = new ReadableStream({ start(value) { controller = value; }, cancel });
  return { response: new Response(body), controller, cancel };
}

beforeEach(() => {
  clearCustomApiSessionStore();
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("custom API pinned outbound transport", () => {
  it("pins every streamed request to the account's same proxy session", async () => {
    proxyAwareFetch.mockImplementation(async () => new Response("ok"));
    const first = await fetchCustomApi(provider, credentials(), url);
    const second = await fetchCustomApi(provider, credentials(), url);
    const [firstProxy, secondProxy] = proxyAwareFetch.mock.calls.map((call) => call[2]);
    expect(firstProxy.connectionProxyUrl).toBe(secondProxy.connectionProxyUrl);
    expect(decodeURIComponent(new URL(firstProxy.connectionProxyUrl).username)).toMatch(/-session-[a-f0-9]{32}-const$/);
    markCustomApiSessionDraining(provider, "a");
    expect(isCustomApiConnectionDraining(provider, "a")).toBe(true);
    await first.text();
    expect(isCustomApiConnectionDraining(provider, "a")).toBe(true);
    await second.text();
    expect(isCustomApiConnectionDraining(provider, "a")).toBe(false);
  });

  it("keeps the old account draining until EOF while another account uses its own session", async () => {
    const old = controlledResponse();
    proxyAwareFetch.mockResolvedValueOnce(old.response).mockResolvedValueOnce(new Response("next account"));
    const first = await fetchCustomApi(provider, credentials("a"), url);
    markCustomApiSessionDraining(provider, "a");
    await expect(fetchCustomApi(provider, credentials("a"), url)).rejects.toThrow(/draining/);
    pinCustomApiConnection(provider, "b");
    const second = await fetchCustomApi(provider, credentials("b"), url);
    expect(getPinnedCustomApiConnectionId(provider)).toBe("b");
    expect(proxyAwareFetch.mock.calls[0][2].connectionProxyUrl).not.toBe(proxyAwareFetch.mock.calls[1][2].connectionProxyUrl);
    expect(isCustomApiConnectionDraining(provider, "a")).toBe(true);
    old.controller.enqueue(encoder.encode("old account finishes"));
    old.controller.close();
    expect(await first.text()).toBe("old account finishes");
    expect(isCustomApiConnectionDraining(provider, "a")).toBe(false);
    expect(getPinnedCustomApiConnectionId(provider)).toBe("b");
    await second.text();
  });

  it("uses strict proxy transport and clears every bypass setting", async () => {
    proxyAwareFetch.mockResolvedValue(new Response("ok"));
    const response = await fetchCustomApi(provider, credentials("a", { connectionNoProxy: "*" }), url, {}, {
      noProxy: "upstream.example", strictProxy: false,
    });
    const transport = proxyAwareFetch.mock.calls[0][2];
    expect(transport.connectionProxyEnabled).toBe(true);
    expect(transport.connectionNoProxy).toBe("");
    expect(transport.noProxy).toBe("");
    expect(transport.strictProxy).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await response.text();
  });

  it.each([
    { connectionProxyEnabled: false },
    { connectionProxyUrl: "" },
    { connectionProxyUrl: "http://user:secret@unsupported.example:8080" },
    { vercelRelayUrl: "https://relay.example" },
  ])("fails closed for an unsupported proxy setup %o", async (overrides) => {
    await expect(fetchCustomApi(provider, credentials("a", overrides), url)).rejects.toThrow(/proxy|Bright Data/);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(getPinnedCustomApiConnectionId(provider)).toBeNull();
  });

  it("does not fall back directly when the proxy fetch throws", async () => {
    proxyAwareFetch.mockRejectedValueOnce(new Error("proxy unavailable"));
    await expect(fetchCustomApi(provider, credentials(), url)).rejects.toThrow("proxy unavailable");
    expect(getPinnedCustomApiConnectionId(provider)).toBeNull();
    expect(isCustomApiConnectionDraining(provider, "a")).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const failedProxy = proxyAwareFetch.mock.calls[0][2].connectionProxyUrl;
    proxyAwareFetch.mockResolvedValueOnce(new Response("retry"));
    const retry = await fetchCustomApi(provider, credentials(), url);
    expect(proxyAwareFetch.mock.calls[1][2].connectionProxyUrl).not.toBe(failedProxy);
    await retry.text();
  });

  it("retains the session when a fetch aborts before receiving response headers", async () => {
    const abort = new AbortController();
    abort.abort();
    proxyAwareFetch.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));
    await expect(fetchCustomApi(provider, credentials(), url, { signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
    const firstProxy = proxyAwareFetch.mock.calls[0][2].connectionProxyUrl;
    expect(getPinnedCustomApiConnectionId(provider)).toBe("a");
    proxyAwareFetch.mockResolvedValueOnce(new Response("retry"));
    const retry = await fetchCustomApi(provider, credentials(), url);
    expect(proxyAwareFetch.mock.calls[1][2].connectionProxyUrl).toBe(firstProxy);
    markCustomApiSessionDraining(provider, "a");
    await retry.text();
    expect(isCustomApiConnectionDraining(provider, "a")).toBe(false);
  });

  it("releases a response with no body immediately", async () => {
    const upstream = new Response(null, { status: 204 });
    proxyAwareFetch.mockResolvedValueOnce(upstream);
    expect(await fetchCustomApi(provider, credentials(), url)).toBe(upstream);
    markCustomApiSessionDraining(provider, "a");
    expect(isCustomApiConnectionDraining(provider, "a")).toBe(false);
    expect(getPinnedCustomApiConnectionId(provider)).toBeNull();
  });

  it("releases on reader errors and replaces the failed session", async () => {
    const fixture = controlledResponse();
    proxyAwareFetch.mockResolvedValueOnce(fixture.response);
    const response = await fetchCustomApi(provider, credentials(), url);
    const oldProxy = proxyAwareFetch.mock.calls[0][2].connectionProxyUrl;
    fixture.controller.error(new Error("stream failed"));
    await expect(response.text()).rejects.toThrow("stream failed");
    expect(getPinnedCustomApiConnectionId(provider)).toBeNull();
    expect(isCustomApiConnectionDraining(provider, "a")).toBe(false);
    proxyAwareFetch.mockResolvedValueOnce(new Response("retry"));
    const retry = await fetchCustomApi(provider, credentials(), url);
    expect(proxyAwareFetch.mock.calls[1][2].connectionProxyUrl).not.toBe(oldProxy);
    await retry.text();
  });

  it("releases after cancellation even if underlying cancellation fails", async () => {
    const fixture = controlledResponse(vi.fn(async () => { throw new Error("cancel failed"); }));
    proxyAwareFetch.mockResolvedValueOnce(fixture.response);
    const response = await fetchCustomApi(provider, credentials(), url);
    markCustomApiSessionDraining(provider, "a");
    await expect(response.body.cancel("client left")).rejects.toThrow("cancel failed");
    expect(fixture.cancel).toHaveBeenCalledWith("client left");
    expect(isCustomApiConnectionDraining(provider, "a")).toBe(false);
  });

  it("waits for upstream cancellation to complete before retiring a live session", async () => {
    const cancelStarted = deferred();
    const cancelFinished = deferred();
    const fixture = controlledResponse(vi.fn(() => {
      cancelStarted.resolve();
      return cancelFinished.promise;
    }));
    proxyAwareFetch.mockResolvedValueOnce(fixture.response);
    const response = await fetchCustomApi(provider, credentials(), url);
    const reader = response.body.getReader();
    const pendingRead = reader.read();
    markCustomApiSessionDraining(provider, "a");
    const cancel = reader.cancel("client left");
    await cancelStarted.promise;
    await Promise.resolve();
    expect(isCustomApiConnectionDraining(provider, "a")).toBe(true);
    cancelFinished.resolve();
    await cancel;
    await pendingRead;
    expect(isCustomApiConnectionDraining(provider, "a")).toBe(false);
  });

  it("waits for an aborted stream's upstream cancellation before releasing its session", async () => {
    const cancelStarted = deferred();
    const cancelFinished = deferred();
    const abort = new AbortController();
    const fixture = controlledResponse(vi.fn(() => {
      cancelStarted.resolve();
      return cancelFinished.promise;
    }));
    proxyAwareFetch.mockResolvedValueOnce(fixture.response);
    const response = await fetchCustomApi(provider, credentials(), url, { signal: abort.signal });
    const reader = response.body.getReader();
    const pendingRead = reader.read().catch((error) => error);
    markCustomApiSessionDraining(provider, "a");
    abort.abort(new Error("client left"));
    await cancelStarted.promise;
    await Promise.resolve();
    expect(isCustomApiConnectionDraining(provider, "a")).toBe(true);
    cancelFinished.resolve();
    expect(await pendingRead).toBeInstanceOf(Error);
    expect(isCustomApiConnectionDraining(provider, "a")).toBe(false);
    expect(fixture.cancel).toHaveBeenCalledTimes(1);
  });

  it("preserves upstream status, headers, metadata and exact body bytes", async () => {
    const upstream = new Response(Uint8Array.from([0, 1, 128, 255]), {
      status: 201, statusText: "Created", headers: { "content-type": "application/octet-stream", "x-test": "value" },
    });
    Object.defineProperties(upstream, {
      url: { value: "https://upstream.example/final" },
      redirected: { value: true },
      type: { value: "basic" },
    });
    proxyAwareFetch.mockResolvedValueOnce(upstream);
    const response = await fetchCustomApi(provider, credentials(), url);
    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Created");
    expect(response.headers.get("x-test")).toBe("value");
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.url).toBe(upstream.url);
    expect(response.redirected).toBe(true);
    expect(response.type).toBe("basic");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.from([0, 1, 128, 255]));
  });

  it("anonymizes each custom attempt before proxy transport while preserving account authentication", async () => {
    proxyAwareFetch.mockResolvedValueOnce(new Response("ok"));
    const response = await fetchCustomApi(provider, credentials("a", { anonymizeRequests: true }), `${url}?session_id=private-session`, {
      method: "POST",
      headers: { authorization: "Bearer account-key", cookie: "private-cookie", "x-session-id": "private-session" },
      body: JSON.stringify({ model: "m", user: "private-user", session_id: "private-session", messages: [{ role: "user", content: "message text" }] }),
    });
    const [sentUrl, sentOptions] = proxyAwareFetch.mock.calls[0];
    expect(sentUrl).toBe(url);
    expect(sentOptions.headers).toEqual({ authorization: "Bearer account-key" });
    expect(JSON.parse(sentOptions.body)).toEqual({ model: "m", messages: [{ role: "user", content: "message text" }] });
    await response.text();
  });
});

describe("ordinary fetch paths", () => {
  it("keeps first-party requests on the existing fetch path", async () => {
    const response = new Response("first-party");
    globalThis.fetch.mockResolvedValueOnce(response);
    const options = { method: "POST", headers: { "x-session-id": "keep" } };
    expect(await fetchCustomApi("openai", credentials(), url, options)).toBe(response);
    expect(globalThis.fetch).toHaveBeenCalledWith(url, options);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("allows opted-out custom requests to use direct fetch without a lease", async () => {
    const response = new Response("opted out");
    globalThis.fetch.mockResolvedValueOnce(response);
    expect(await fetchCustomApi(provider, credentials("a", { customApiSessionPinning: false, connectionProxyEnabled: false }), url)).toBe(response);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(getPinnedCustomApiConnectionId(provider)).toBeNull();
  });
});
