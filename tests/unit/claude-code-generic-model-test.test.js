import { beforeEach, describe, expect, it, vi } from "vitest";

const fx = vi.hoisted(() => ({
  getModelInfo: vi.fn(),
  getProviderCredentials: vi.fn(),
  getProviderConnectionById: vi.fn(),
  probeConnectionModel: vi.fn(),
  pingModelByKind: vi.fn(),
}));

vi.mock("@/sse/services/model", () => ({ getModelInfo: fx.getModelInfo }));
vi.mock("@/sse/services/auth", () => ({ getProviderCredentials: fx.getProviderCredentials }));
vi.mock("@/lib/localDb", () => ({ getProviderConnectionById: fx.getProviderConnectionById }));
vi.mock("@/lib/modelProbe/probe", () => ({ probeConnectionModel: fx.probeConnectionModel }));
vi.mock("@/app/api/models/test/ping", () => ({ pingModelByKind: fx.pingModelByKind }));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) => Response.json(body, init),
  },
}));

const { POST } = await import("../../src/app/api/models/test/route.js");
const provider = "anthropic-compatible-custom";
const success = { ok: true, error: null, latencyMs: 25, status: 200 };
const connection = (mode) => ({
  id: "chosen-key",
  provider,
  apiKey: "upstream-key",
  providerSpecificData: { baseUrl: "https://upstream.example/v1", executionMode: mode },
});
const request = (body = { model: "my-anthropic/claude-model" }) => new Request("http://localhost/api/models/test", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("generic model tests honor the selected custom Anthropic key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fx.getModelInfo.mockResolvedValue({ provider, model: "claude-model" });
    fx.getProviderCredentials.mockResolvedValue({ connectionId: "chosen-key" });
    fx.getProviderConnectionById.mockResolvedValue(connection("claude-code"));
    fx.probeConnectionModel.mockResolvedValue(success);
    fx.pingModelByKind.mockResolvedValue(success);
  });

  it("resolves a custom prefix and probes the exact selected Claude Code connection", async () => {
    const req = request();
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(success);
    expect(fx.getModelInfo).toHaveBeenCalledWith("my-anthropic/claude-model");
    expect(fx.getProviderCredentials).toHaveBeenCalledWith(provider, new Set(), "claude-model");
    expect(fx.getProviderConnectionById).toHaveBeenCalledWith("chosen-key");
    expect(fx.probeConnectionModel).toHaveBeenCalledWith(connection("claude-code"), "claude-model", { signal: req.signal });
    expect(fx.pingModelByKind).not.toHaveBeenCalled();
  });

  it("passes a selected direct key through the same probe without enabling Claude Code", async () => {
    fx.getProviderConnectionById.mockResolvedValue(connection("direct"));
    const req = request({ model: "my-anthropic/claude-model", kind: "llm" });

    expect(await (await POST(req)).json()).toEqual(success);
    expect(fx.probeConnectionModel).toHaveBeenCalledWith(connection("direct"), "claude-model", { signal: req.signal });
    expect(fx.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(fx.pingModelByKind).not.toHaveBeenCalled();
  });

  it("returns the chosen key's failure without retrying another key or the internal endpoint", async () => {
    const failure = { ok: false, error: "HTTP 403: model denied", latencyMs: 21, status: 403 };
    fx.probeConnectionModel.mockResolvedValue(failure);

    expect(await (await POST(request())).json()).toEqual(failure);
    expect(fx.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(fx.getProviderConnectionById).toHaveBeenCalledTimes(1);
    expect(fx.probeConnectionModel).toHaveBeenCalledTimes(1);
    expect(fx.pingModelByKind).not.toHaveBeenCalled();
  });

  it("returns a failed verdict if there are no active credentials", async () => {
    fx.getProviderCredentials.mockResolvedValue(null);

    expect(await (await POST(request())).json()).toEqual({
      ok: false,
      error: `No active credentials for provider: ${provider}`,
      latencyMs: expect.any(Number),
      status: 404,
    });
    expect(fx.getProviderConnectionById).not.toHaveBeenCalled();
    expect(fx.probeConnectionModel).not.toHaveBeenCalled();
    expect(fx.pingModelByKind).not.toHaveBeenCalled();
  });

  it("returns a failed verdict when every key is rate limited", async () => {
    fx.getProviderCredentials.mockResolvedValue({ allRateLimited: true, lastError: "Rate limit exceeded" });

    expect(await (await POST(request())).json()).toEqual({
      ok: false, error: "Rate limit exceeded", latencyMs: expect.any(Number), status: 503,
    });
    expect(fx.getProviderConnectionById).not.toHaveBeenCalled();
    expect(fx.probeConnectionModel).not.toHaveBeenCalled();
    expect(fx.pingModelByKind).not.toHaveBeenCalled();
  });

  it("returns a failed verdict if the selected connection was removed", async () => {
    fx.getProviderConnectionById.mockResolvedValue(null);

    expect(await (await POST(request())).json()).toEqual({
      ok: false, error: "Connection not found", latencyMs: expect.any(Number), status: 404,
    });
    expect(fx.probeConnectionModel).not.toHaveBeenCalled();
    expect(fx.pingModelByKind).not.toHaveBeenCalled();
  });

  it.each(["openai", "openai-compatible-custom", null])("preserves the internal LLM test for provider %s", async (otherProvider) => {
    fx.getModelInfo.mockResolvedValue({ provider: otherProvider, model: "some-model" });
    const req = request({ model: "other/some-model", kind: "llm" });

    expect(await (await POST(req)).json()).toEqual(success);
    expect(fx.pingModelByKind).toHaveBeenCalledWith("other/some-model", "llm");
    expect(fx.getProviderCredentials).not.toHaveBeenCalled();
    expect(fx.getProviderConnectionById).not.toHaveBeenCalled();
    expect(fx.probeConnectionModel).not.toHaveBeenCalled();
  });

  it.each(["embedding", "image", "stt", "systemone"])("preserves %s model routing without inspecting LLM credentials", async (kind) => {
    expect(await (await POST(request({ model: "some/model", kind }))).json()).toEqual(success);

    expect(fx.pingModelByKind).toHaveBeenCalledWith("some/model", kind);
    expect(fx.getModelInfo).not.toHaveBeenCalled();
    expect(fx.getProviderCredentials).not.toHaveBeenCalled();
    expect(fx.probeConnectionModel).not.toHaveBeenCalled();
  });

  it("still rejects a missing model", async () => {
    const res = await POST(request({ kind: "llm" }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Model required" });
    expect(fx.getModelInfo).not.toHaveBeenCalled();
    expect(fx.pingModelByKind).not.toHaveBeenCalled();
  });
});
