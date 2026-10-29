import { beforeEach, describe, expect, it, vi } from "vitest";

const { outbound } = vi.hoisted(() => ({ outbound: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: outbound }));

import { BaseExecutor } from "../../open-sse/executors/base.js";
import {
  clearCustomApiSessionStore,
  getPinnedCustomApiConnectionId,
  isCustomApiConnectionDraining,
  markCustomApiSessionDraining,
} from "../../open-sse/utils/customApiSession.js";

const provider = "openai-compatible-executor-session";
const credentials = () => ({
  connectionId: "account-a",
  apiKey: "required-key",
  providerSpecificData: {
    baseUrl: "https://custom.test/v1",
    anonymizeRequests: true,
    customApiSessionPinning: true,
    connectionProxyEnabled: true,
    connectionProxyUrl: "http://brd-customer-test-zone-test:secret@brd.superproxy.io:33335",
  },
});
const request = (creds = credentials()) => ({
  model: "model", body: { messages: [], user: "private-user" },
  stream: true, credentials: creds,
  providerOverrides: { headers: { "X-Session-ID": "private-session", "X-Feature": "enabled" } },
});

beforeEach(() => {
  outbound.mockReset();
  clearCustomApiSessionStore();
});

describe("custom API executor transport", () => {
  it("sanitizes chat requests and holds the account's proxy session until the response is cancelled", async () => {
    const executor = new BaseExecutor(provider, {});
    outbound.mockResolvedValue(new Response(new ReadableStream()));
    const directFetch = vi.fn();
    const result = await executor.execute({ ...request(), directFetch });

    const [url, options, proxy] = outbound.mock.calls[0];
    expect(url).toBe("https://custom.test/v1/chat/completions");
    expect(options.headers).toEqual({
      "Content-Type": "application/json", Authorization: "Bearer required-key",
      Accept: "text/event-stream", "X-Feature": "enabled",
    });
    expect(JSON.parse(options.body)).toEqual({ messages: [] });
    expect(options.directFetch).toBe(directFetch);
    expect(proxy.strictProxy).toBe(true);
    expect(new URL(proxy.connectionProxyUrl).username).toMatch(/^brd-customer-test-zone-test-session-[a-f0-9]+-const$/);
    expect(getPinnedCustomApiConnectionId(provider)).toBe("account-a");

    markCustomApiSessionDraining(provider, "account-a");
    expect(isCustomApiConnectionDraining(provider, "account-a")).toBe(true);
    await result.response.body.cancel();
    expect(isCustomApiConnectionDraining(provider, "account-a")).toBe(false);
  });

  it.each(["retry", "fallback"])("finishes cancelling a pinned response before a %s", async (mode) => {
    const executor = new BaseExecutor(provider, {
      baseUrls: ["https://first.test/api", "https://second.test/api"],
      retry: { 429: { attempts: mode === "retry" ? 1 : 0, delayMs: 0 } },
    });
    executor.buildUrl = (_model, _stream, index) => executor.config.baseUrls[index];
    let finishCancellation;
    const cancellation = new Promise(resolve => { finishCancellation = resolve; });
    const cancel = vi.fn(() => cancellation);
    outbound.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 429 }))
      .mockResolvedValueOnce(new Response(new ReadableStream()));

    const pending = executor.execute(request());
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(outbound).toHaveBeenCalledOnce();
    finishCancellation();
    const result = await pending;
    expect(outbound).toHaveBeenCalledTimes(2);
    expect(result.url).toBe(mode === "retry" ? "https://first.test/api" : "https://second.test/api");
    expect(outbound.mock.calls[1][2].connectionProxyUrl).toBe(outbound.mock.calls[0][2].connectionProxyUrl);

    // The discarded first response must no longer hold a lease.
    markCustomApiSessionDraining(provider, "account-a");
    await result.response.body.cancel();
    expect(isCustomApiConnectionDraining(provider, "account-a")).toBe(false);
  });

  it("preserves identifiers and the configured proxy when both custom policies are disabled", async () => {
    const executor = new BaseExecutor(provider, {});
    const creds = credentials();
    Object.assign(creds.providerSpecificData, { anonymizeRequests: false, customApiSessionPinning: false });
    outbound.mockResolvedValue(new Response(null, { status: 204 }));
    await executor.execute(request(creds));

    const [, options, proxy] = outbound.mock.calls[0];
    expect(JSON.parse(options.body).user).toBe("private-user");
    expect(options.headers["X-Session-ID"]).toBe("private-session");
    expect(proxy.connectionProxyUrl).toBe(creds.providerSpecificData.connectionProxyUrl);
    expect(getPinnedCustomApiConnectionId(provider)).toBeNull();
  });
});
