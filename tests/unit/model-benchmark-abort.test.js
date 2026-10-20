import { describe, expect, it, vi } from "vitest";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("open-sse/executors/index.js", () => ({ getExecutor: () => ({ noAuth: true, execute }) }));
vi.mock("open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest() {}, logRawRequest() {}, logTargetRequest() {},
    logProviderResponse() {}, logConvertedResponse() {}, logError() {},
  }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest() {}, appendRequestLog: async () => {}, saveRequestDetail: async () => {}, saveRequestUsage: async () => {},
}));

import { handleChatCore } from "open-sse/handlers/chatCore.js";

describe("model benchmark cancellation", () => {
  it("aborts the provider executor when the caller cancels during its request", async () => {
    const caller = new AbortController();
    execute.mockImplementationOnce(async ({ signal }) => {
      expect(signal.aborted).toBe(false);
      caller.abort(new DOMException("Test canceled", "AbortError"));
      expect(signal.aborted).toBe(true);
      signal.throwIfAborted();
    });

    const result = await handleChatCore({
      body: { model: "openai/gpt-4o", messages: [{ role: "user", content: "write a small essay" }], stream: true },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "test-key" },
      connectionId: "test-connection", signal: caller.signal,
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ success: false, status: 499, error: "Request aborted" });
  });
});
