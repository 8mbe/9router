import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fx = vi.hoisted(() => ({ getExecutor: vi.fn(), createRequestLogger: vi.fn() }));

vi.mock("open-sse/executors/index.js", () => ({ getExecutor: fx.getExecutor }));
vi.mock("open-sse/utils/requestLogger.js", () => ({ createRequestLogger: fx.createRequestLogger }));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(), saveRequestDetail: vi.fn(), saveRequestUsage: vi.fn(),
}));

import { handleChatCore } from "open-sse/handlers/chatCore.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => vi.unstubAllGlobals());

describe("Treg has no chat transport", () => {
  it.each(["openai", "claude", "openai-responses"])("rejects %s chat before choosing an executor or touching credentials", async (sourceFormatOverride) => {
    const credentials = Object.freeze({ apiKey: "private-treg-token", providerSpecificData: {} });
    const result = await handleChatCore({
      body: null, modelInfo: { provider: "treg", model: "replicate.image-gen.flux-schnell" },
      credentials, sourceFormatOverride,
    });

    expect(result).toMatchObject({ success: false, status: 400, error: "Provider 'treg' does not support chat completions" });
    expect(result.response.status).toBe(400);
    expect((await result.response.json()).error.message).toBe(result.error);
    expect(fx.getExecutor).not.toHaveBeenCalled();
    expect(fx.createRequestLogger).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(Object.keys(credentials)).toEqual(["apiKey", "providerSpecificData"]);
  });
});
