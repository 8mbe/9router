import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), resolveProxy: vi.fn() }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.fetch }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: mocks.resolveProxy }));

import { fetchCustomApiDiagnostic } from "@/lib/network/customApi";
import { fetchCustomApi } from "open-sse/utils/customApiFetch.js";
import { clearCustomApiSessionStore, getPinnedCustomApiConnectionId, isCustomApiConnectionDraining, markCustomApiSessionDraining } from "open-sse/utils/customApiSession.js";

const provider = "openai-compatible-chat-diagnostic";
const proxy = {
  connectionProxyEnabled: true,
  connectionProxyUrl: "http://brd-customer-test-zone-test:password@brd.superproxy.io:33335",
};
const connection = {
  id: "account-a", provider, apiKey: "upstream-key",
  providerSpecificData: { anonymizeRequests: true, customApiSessionPinning: true, proxyPoolId: "pool-a" },
};
const url = "https://custom.test/v1/models";

beforeEach(() => {
  clearCustomApiSessionStore();
  vi.clearAllMocks();
  mocks.resolveProxy.mockResolvedValue(proxy);
  mocks.fetch.mockImplementation(async () => new Response('{"data":[{"id":"model-a"}]}'));
});

describe("custom API diagnostic sessions", () => {
  it("uses the inference session for a saved account and resolves its pool", async () => {
    const credentials = { ...connection, connectionId: connection.id, providerSpecificData: { ...connection.providerSpecificData, ...proxy } };
    await (await fetchCustomApi(provider, credentials, url)).text();
    const diagnostic = await fetchCustomApiDiagnostic(connection, url);
    expect(mocks.resolveProxy).toHaveBeenCalledWith(connection.providerSpecificData);
    expect(mocks.fetch.mock.calls[1][2].connectionProxyUrl).toBe(mocks.fetch.mock.calls[0][2].connectionProxyUrl);
    expect(await diagnostic.json()).toEqual({ data: [{ id: "model-a" }] });
  });

  it("consumes status-only diagnostics so ignored bodies cannot block draining", async () => {
    const diagnostic = await fetchCustomApiDiagnostic(connection, url);
    expect(diagnostic.ok).toBe(true);
    markCustomApiSessionDraining(provider, connection.id);
    expect(isCustomApiConnectionDraining(provider, connection.id)).toBe(false);
    expect(getPinnedCustomApiConnectionId(provider)).toBeNull();
  });

  it("isolates pre-save keys while using the same session for repeated validation of one key", async () => {
    const unsaved = { ...connection, id: undefined };
    await fetchCustomApiDiagnostic(unsaved, url);
    await fetchCustomApiDiagnostic(unsaved, url);
    await fetchCustomApiDiagnostic({ ...unsaved, apiKey: "different-key" }, url);
    const urls = mocks.fetch.mock.calls.map(call => call[2].connectionProxyUrl);
    expect(urls[1]).toBe(urls[0]);
    expect(urls[2]).not.toBe(urls[0]);
    expect(urls.join(" ")).not.toContain("upstream-key");
  });

  it("scrubs identifiers from diagnostic overrides while retaining upstream authentication", async () => {
    await fetchCustomApiDiagnostic(connection, `${url}?session_id=private&api_key=auth`, {
      headers: { Authorization: "Bearer upstream-key", "X-Session-Id": "private", "User-Agent": "personal-client" },
      body: JSON.stringify({ input: "ping", metadata: { owner: "private" }, user: "private" }),
    });
    const [actualUrl, options] = mocks.fetch.mock.calls[0];
    expect(actualUrl).toBe(`${url}?api_key=auth`);
    expect(options.headers).toEqual({ Authorization: "Bearer upstream-key" });
    expect(JSON.parse(options.body)).toEqual({ input: "ping" });
  });

  it("retires a diagnostic whose response stream fails", async () => {
    mocks.fetch.mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.error(new Error("upstream failed")); },
    })));
    await expect(fetchCustomApiDiagnostic(connection, url)).rejects.toThrow("upstream failed");
    expect(getPinnedCustomApiConnectionId(provider)).toBeNull();
    expect(isCustomApiConnectionDraining(provider, connection.id)).toBe(false);
  });
});
