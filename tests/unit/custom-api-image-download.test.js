import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { proxyFetch, delegate } = vi.hoisted(() => ({ proxyFetch: vi.fn(), delegate: { enabled: false } }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => proxyFetch(...args) }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => ({ noAuth: true }) }));
vi.mock("../../open-sse/services/tokenRefresh.js", () => ({ refreshWithRetry: vi.fn() }));
vi.mock("../../open-sse/handlers/imageProviders/index.js", async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getImageAdapter: (provider) => delegate.enabled ? {
    useExecutor: true,
    executeViaExecutor: async (_model, _body, credentials) => {
      const response = await fetchCustomApi(provider, credentials, "https://custom.test/v1/images/generations");
      return response.json();
    },
    normalize: (body) => body,
  } : original.getImageAdapter(provider) };
});

import { fetchCustomApi } from "../../open-sse/utils/customApiFetch.js";
import { clearCustomApiSessionStore } from "../../open-sse/utils/customApiSession.js";
import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";

const provider = "openai-compatible-images";
const credentials = {
  connectionId: "account-a", apiKey: "private-api-key",
  providerSpecificData: {
    baseUrl: "https://custom.test/v1", anonymizeRequests: true, customApiSessionPinning: true,
    connectionProxyEnabled: true, connectionProxyUrl: "http://brd-customer-c-zone-z:secret@brd.superproxy.io:33335",
  },
};

beforeEach(() => {
  clearCustomApiSessionStore();
  proxyFetch.mockReset();
  delegate.enabled = false;
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe("custom API image URL downloads", () => {
  it.each([false, true])("uses the account's opaque proxy session for the binary image with executor delegation=%s", async (delegated) => {
    delegate.enabled = delegated;
    proxyFetch.mockResolvedValueOnce(new Response(JSON.stringify({ created: 1, data: [{ url: "https://cdn.test/generated.png?session_id=client&signature=signed" }] }), {
      headers: { "content-type": "application/json" },
    })).mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }));

    const result = await handleImageGenerationCore({
      modelInfo: { provider, model: "image-model" }, credentials, binaryOutput: true, body: { prompt: "a cat" },
    });
    expect(result.success).toBe(true);
    expect(new Uint8Array(await result.response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(proxyFetch).toHaveBeenCalledTimes(2);
    const [generation, download] = proxyFetch.mock.calls;
    expect(download[0]).toBe("https://cdn.test/generated.png?signature=signed");
    expect(download[2].connectionProxyUrl).toBe(generation[2].connectionProxyUrl);
    expect(decodeURIComponent(new URL(download[2].connectionProxyUrl).username)).toMatch(/-session-[a-f0-9]{32}-const$/);
    expect(download[2].connectionProxyUrl).not.toContain("account-a");
    expect(download[2].connectionProxyUrl).not.toContain("private-api-key");
    expect(download[2].strictProxy).toBe(true);
    expect(new Headers(download[1].headers).get("authorization")).toBeNull();
    expect(new Headers(download[1].headers).get("x-api-key")).toBeNull();
    expect(download[1].signal).toBeInstanceOf(AbortSignal);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
