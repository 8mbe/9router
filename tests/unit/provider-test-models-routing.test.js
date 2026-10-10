import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  getApiKeys: vi.fn(),
  getConsistentMachineId: vi.fn(),
  probeConnectionModel: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  getApiKeys: mocks.getApiKeys,
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

vi.mock("@/lib/modelProbe/probe", () => ({
  probeConnectionModel: mocks.probeConnectionModel,
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
}));

const originalFetch = global.fetch;

describe("provider test-models route kind routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-hf",
      provider: "huggingface",
    });
    mocks.getApiKeys.mockResolvedValue([{ key: "sk-internal", isActive: true }]);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    global.fetch = vi.fn((url) => {
      if (String(url).includes("/api/v1/images/generations")) {
        return Promise.resolve(new Response(JSON.stringify({
          created: 1,
          data: [{ b64_json: "abc" }],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" } }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("routes huggingface image models to /api/v1/images/generations", async () => {
    const { POST } = await import("../../src/app/api/providers/[id]/test-models/route.js");

    const req = new Request("http://localhost/api/providers/conn-hf/test-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req, { params: Promise.resolve({ id: "conn-hf" }) });
    const body = await res.json();

    expect(body.provider).toBe("huggingface");
    expect(body.results.some((r) => r.modelId === "black-forest-labs/FLUX.1-schnell" && r.ok)).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/images/generations"),
      expect.objectContaining({
        method: "POST",
      })
    );
  });

  it("tests Claude Code models with the selected connection, warming up before parallel probes", async () => {
    const connection = {
      id: "conn-anthropic",
      provider: "anthropic-compatible-acme",
      apiKey: "selected-upstream-key",
      providerSpecificData: { baseUrl: "https://acme.test/v1", executionMode: "claude-code" },
    };
    mocks.getProviderConnectionById.mockResolvedValue(connection);
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      models: [{ id: "sonnet" }, { id: "opus" }, { id: "haiku" }],
    }), { status: 200 }));

    let finishWarmup;
    mocks.probeConnectionModel.mockImplementationOnce(() => new Promise((resolve) => { finishWarmup = resolve; }));
    mocks.probeConnectionModel.mockResolvedValue({ ok: true, latencyMs: 15, status: 200 });
    const { POST } = await import("../../src/app/api/providers/[id]/test-models/route.js");
    const request = new Request("http://localhost/api/providers/conn-anthropic/test-models", { method: "POST" });
    const pending = POST(request, { params: Promise.resolve({ id: connection.id }) });

    await vi.waitFor(() => expect(mocks.probeConnectionModel).toHaveBeenCalledTimes(1));
    expect(mocks.probeConnectionModel).toHaveBeenNthCalledWith(1, connection, "sonnet", { signal: request.signal });
    finishWarmup({ ok: true, latencyMs: 9, status: 200 });
    const response = await pending;
    const body = await response.json();

    expect(body.connectionId).toBe(connection.id);
    expect(body.results.map((result) => result.modelId)).toEqual(["sonnet", "opus", "haiku"]);
    expect(body.results.every((result) => result.ok)).toBe(true);
    expect(mocks.probeConnectionModel).toHaveBeenNthCalledWith(2, connection, "opus", { signal: request.signal });
    expect(mocks.probeConnectionModel).toHaveBeenNthCalledWith(3, connection, "haiku", { signal: request.signal });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(String(global.fetch.mock.calls[0][0])).toContain(`/api/providers/${connection.id}/models`);
    expect(mocks.getApiKeys).not.toHaveBeenCalled();
  });

  it("tests a direct-mode Anthropic connection with that exact key and mode", async () => {
    const connection = {
      id: "conn-direct",
      provider: "anthropic-compatible-acme",
      apiKey: "selected-direct-key",
      providerSpecificData: { baseUrl: "https://acme.test/v1", executionMode: "direct" },
    };
    mocks.getProviderConnectionById.mockResolvedValue(connection);
    mocks.probeConnectionModel.mockResolvedValue({ ok: true, status: 200 });
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [{ id: "sonnet" }] }), { status: 200 }));
    const { POST } = await import("../../src/app/api/providers/[id]/test-models/route.js");
    const request = new Request("http://localhost/api/providers/conn-direct/test-models", { method: "POST" });
    const response = await POST(request, {
      params: Promise.resolve({ id: "conn-direct" }),
    });
    expect((await response.json()).results[0].ok).toBe(true);
    expect(mocks.probeConnectionModel).toHaveBeenCalledWith(connection, "sonnet", { signal: request.signal });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(String(global.fetch.mock.calls[0][0])).toContain("/api/providers/conn-direct/models");
    expect(mocks.getApiKeys).not.toHaveBeenCalled();
  });

  it("preserves non-LLM routing when the Anthropic key has Claude Code enabled", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-anthropic",
      provider: "anthropic-compatible-acme",
      providerSpecificData: { executionMode: "claude-code" },
    });
    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ id: "image-model", type: "image" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ b64_json: "abc" }] }), { status: 200 }));
    const { POST } = await import("../../src/app/api/providers/[id]/test-models/route.js");
    const response = await POST(new Request("http://localhost/api/providers/conn-anthropic/test-models", { method: "POST" }), {
      params: Promise.resolve({ id: "conn-anthropic" }),
    });
    expect((await response.json()).results[0].ok).toBe(true);
    expect(mocks.probeConnectionModel).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenLastCalledWith(expect.stringContaining("/api/v1/images/generations"), expect.objectContaining({
      body: JSON.stringify({ model: "anthropic-compatible-acme/image-model", prompt: "test" }),
    }));
  });

  it("bounds parallel Claude Code processes and preserves the model list order", async () => {
    const modelIds = Array.from({ length: 9 }, (_, index) => `model-${index}`);
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-anthropic",
      provider: "anthropic-compatible-acme",
      providerSpecificData: { executionMode: "claude-code" },
    });
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: modelIds.map((id) => ({ id })) }), { status: 200 }));
    let inFlight = 0;
    let peak = 0;
    mocks.probeConnectionModel.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { ok: true, status: 200 };
    });
    const { POST } = await import("../../src/app/api/providers/[id]/test-models/route.js");
    const response = await POST(new Request("http://localhost/api/providers/conn-anthropic/test-models", { method: "POST" }), {
      params: Promise.resolve({ id: "conn-anthropic" }),
    });
    expect(peak).toBe(4);
    expect(mocks.probeConnectionModel).toHaveBeenCalledTimes(modelIds.length);
    expect((await response.json()).results.map((result) => result.modelId)).toEqual(modelIds);
  });

  it("forwards dashboard authentication to the local model catalog and treats type:model as an LLM", async () => {
    const connection = {
      id: "conn-anthropic",
      provider: "anthropic-compatible-acme",
      apiKey: "selected-key",
      providerSpecificData: { executionMode: "claude-code" },
    };
    mocks.getProviderConnectionById.mockResolvedValue(connection);
    mocks.probeConnectionModel.mockResolvedValue({ ok: true, status: 200 });
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [{ id: "sonnet", type: "model" }] }), { status: 200 }));
    const { POST } = await import("../../src/app/api/providers/[id]/test-models/route.js");
    const request = new Request("http://localhost/api/providers/conn-anthropic/test-models", {
      method: "POST",
      headers: { cookie: "9router-auth=dashboard-session" },
    });
    const response = await POST(request, { params: Promise.resolve({ id: connection.id }) });

    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining(`/api/providers/${connection.id}/models`), {
      headers: { cookie: "9router-auth=dashboard-session" },
    });
    expect(mocks.probeConnectionModel).toHaveBeenCalledWith(connection, "sonnet", { signal: request.signal });
    expect((await response.json()).results[0]).toMatchObject({ modelId: "sonnet", ok: true });
  });
});
