import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderNodeById: vi.fn(),
  probeModelEndpoint: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));

vi.mock("@/models", () => ({ getProviderNodeById: mocks.getProviderNodeById }));
vi.mock("@/lib/modelProbe/probe", () => ({ probeModelEndpoint: mocks.probeModelEndpoint }));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
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

const { POST } = await import("../../src/app/api/providers/validate-model/route.js");
const provider = "anthropic-compatible-acme";

function requestFor(body, options = {}) {
  return new Request("http://localhost/api/providers/validate-model", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, apiKey: "upstream-key", model: " acme-sonnet ", ...body }),
    ...options,
  });
}

describe("pre-save Anthropic model checks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderNodeById.mockResolvedValue({ baseUrl: "https://acme.test/v1" });
    mocks.resolveConnectionProxyConfig.mockResolvedValue({ connectionProxyEnabled: false });
    mocks.probeModelEndpoint.mockResolvedValue({ ok: true, status: 200, latencyMs: 12 });
  });

  it.each(["claude-code", "direct"])("passes the selected %s mode and authoritative node URL to the shared probe", async (executionMode) => {
    const response = await POST(requestFor({
      providerSpecificData: { executionMode, baseUrl: "https://form.test/ignored", customHeader: "test" },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, model: "acme-sonnet", latencyMs: 12 });
    expect(mocks.getProviderNodeById).toHaveBeenCalledWith(provider);
    expect(mocks.probeModelEndpoint).toHaveBeenCalledWith(expect.objectContaining({
      provider,
      baseUrl: "https://acme.test/v1",
      format: "claude",
      apiKey: "upstream-key",
      model: "acme-sonnet",
      providerSpecificData: {
        executionMode,
        baseUrl: "https://acme.test/v1",
        customHeader: "test",
      },
      proxy: { connectionProxyEnabled: false },
      signal: expect.any(AbortSignal),
    }));
  });

  it("does not opt into Claude Code when no execution mode was selected", async () => {
    await POST(requestFor({}));
    const options = mocks.probeModelEndpoint.mock.calls[0][0];
    expect(options.providerSpecificData).toEqual({ baseUrl: "https://acme.test/v1" });
  });

  it("cancels a model check when its dashboard request is aborted", async () => {
    const controller = new AbortController();
    const request = requestFor({ providerSpecificData: { executionMode: "claude-code" } }, { signal: controller.signal });
    await POST(request);
    const signal = mocks.probeModelEndpoint.mock.calls[0][0].signal;
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  it.each(["server", null, true])("rejects invalid execution mode %s before starting a model test", async (executionMode) => {
    const response = await POST(requestFor({ providerSpecificData: { executionMode } }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Execution mode must be direct or claude-code" });
    expect(mocks.probeModelEndpoint).not.toHaveBeenCalled();
    expect(mocks.getProviderNodeById).not.toHaveBeenCalled();
  });

  it("rejects execution mode on a provider that cannot use Claude Code", async () => {
    const response = await POST(requestFor({ provider: "openai-compatible-acme", providerSpecificData: { executionMode: "claude-code" } }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Execution mode is only supported for custom Anthropic-compatible connections" });
    expect(mocks.probeModelEndpoint).not.toHaveBeenCalled();
  });

  it("returns a runtime failure as a model verdict", async () => {
    mocks.probeModelEndpoint.mockResolvedValue({ ok: false, error: "Claude Code could not start", status: 502, latencyMs: 7 });
    const response = await POST(requestFor({ providerSpecificData: { executionMode: "claude-code" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: false, supported: true, error: "Claude Code could not start", status: 502 });
  });
});
