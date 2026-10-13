import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { proxyFetch } = vi.hoisted(() => ({ proxyFetch: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => proxyFetch(...args) }));

import { handleSttCore } from "../../open-sse/handlers/sttCore.js";
import {
  clearCustomApiSessionStore,
  markCustomApiSessionDraining,
  isCustomApiConnectionDraining,
} from "../../open-sse/utils/customApiSession.js";

const provider = "openai-compatible-transcription";
const credentials = {
  connectionId: "account-a", apiKey: "private-api-key",
  providerSpecificData: {
    baseUrl: "https://custom.test/v1", anonymizeRequests: true, customApiSessionPinning: true,
    connectionProxyEnabled: true, connectionProxyUrl: "http://brd-customer-c-zone-z:secret@brd.superproxy.io:33335",
  },
};
const jsonResponse = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

beforeEach(() => {
  clearCustomApiSessionStore();
  proxyFetch.mockReset();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("custom transcription poll leases", () => {
  it("stops a failed poll body before retrying and releases every request lease", async () => {
    const cancel = vi.fn();
    const failedPoll = new Response(new ReadableStream({ cancel }), { status: 503 });
    proxyFetch.mockResolvedValueOnce(jsonResponse({ upload_url: "https://custom.test/uploaded" }))
      .mockResolvedValueOnce(jsonResponse({ id: "transcription-a" }))
      .mockResolvedValueOnce(failedPoll)
      .mockImplementationOnce(async () => {
        expect(cancel).toHaveBeenCalledTimes(1);
        return jsonResponse({ status: "completed", text: "hello" });
      });
    const form = new FormData();
    form.append("file", new Blob(["audio"]), "audio.wav");
    const pending = handleSttCore({
      provider, model: "transcription-model", formData: form, credentials,
      sttConfig: { baseUrl: "https://custom.test", authType: "apiKey", format: "assemblyai" },
    });
    await vi.waitFor(() => expect(proxyFetch).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(4000);
    const result = await pending;
    expect(result.success).toBe(true);
    expect(await result.response.json()).toEqual({ text: "hello" });
    expect(proxyFetch).toHaveBeenCalledTimes(4);
    const sessions = proxyFetch.mock.calls.map((call) => call[2].connectionProxyUrl);
    expect(new Set(sessions).size).toBe(1);
    markCustomApiSessionDraining(provider, credentials.connectionId);
    expect(isCustomApiConnectionDraining(provider, credentials.connectionId)).toBe(false);
  });
});
