import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), resolveProxy: vi.fn() }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.fetch }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: mocks.resolveProxy }));

import { fetchCustomApiDiagnostic } from "@/lib/network/customApi";
import { probeConnectionModel } from "@/lib/modelProbe/probe";
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

afterEach(() => vi.restoreAllMocks());

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

  it("returns streaming diagnostics before output and releases the session on cancellation", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    mocks.fetch.mockResolvedValue(new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), {
      headers: { "content-type": "text/event-stream" },
    }));

    const diagnostic = await fetchCustomApiDiagnostic(connection, url, {}, proxy, { streamResponse: true });
    expect(pull).not.toHaveBeenCalled();
    markCustomApiSessionDraining(provider, connection.id);
    expect(isCustomApiConnectionDraining(provider, connection.id)).toBe(true);
    await diagnostic.body.cancel();
    expect(cancel).toHaveBeenCalledOnce();
    expect(isCustomApiConnectionDraining(provider, connection.id)).toBe(false);
  });

  it("measures pinned essay output as it arrives and keeps the lease until terminal cancellation finishes", async () => {
    let time = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => time);
    const event = (value) => new TextEncoder().encode(`data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`);
    const chunks = [
      [1100, { choices: [{ delta: { role: "assistant" } }] }],
      [1200, { choices: [{ delta: { content: "Small " } }] }],
      [1600, { choices: [{ delta: { content: "essay." } }] }],
      [1900, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 20 } }],
      [2200, "[DONE]"],
    ];
    let signalCancellation;
    const cancellationStarted = new Promise((resolve) => { signalCancellation = resolve; });
    let releaseCancellation;
    const cancellationFinished = new Promise((resolve) => { releaseCancellation = resolve; });
    const cancel = vi.fn(() => { signalCancellation(); return cancellationFinished; });
    mocks.fetch.mockResolvedValue(new Response(new ReadableStream({
      pull(controller) {
        const chunk = chunks.shift();
        if (!chunk) return; // The gateway leaves the socket open after [DONE].
        time = chunk[0];
        if (chunk[1] === "[DONE]") markCustomApiSessionDraining(provider, connection.id);
        controller.enqueue(event(chunk[1]));
      },
      cancel,
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } }));

    const pending = probeConnectionModel({
      ...connection, providerSpecificData: { ...connection.providerSpecificData, baseUrl: "https://custom.test/v1" },
    }, "essay-model", { testType: "essay", proxy });
    await cancellationStarted;
    expect(isCustomApiConnectionDraining(provider, connection.id)).toBe(true);
    releaseCancellation();
    expect(await pending).toMatchObject({
      ok: true, ttftMs: 200, responseDurationMs: 400, tokensPerSecond: 50, outputTokens: 20,
    });
    expect(isCustomApiConnectionDraining(provider, connection.id)).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
