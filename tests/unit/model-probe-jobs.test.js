import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  setModelProbe: vi.fn(),
  probeConnectionModel: vi.fn(),
  fetchModelContextLengths: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({ getProviderConnectionById: mocks.getProviderConnectionById }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig }));
vi.mock("@/lib/db/repos/modelProbesRepo.js", () => ({ setModelProbe: mocks.setModelProbe }));
vi.mock("@/lib/modelProbe/probe", () => ({
  probeConnectionModel: mocks.probeConnectionModel,
  fetchModelContextLengths: mocks.fetchModelContextLengths,
}));

const {
  startProbeJob, serializeJob, getProbeResultsForProvider,
  clearProbeResultsForProvider, cancelJob,
} = await import("@/lib/modelProbe/jobs.js");

const providerId = "openai-compatible-test";
const start = (options = {}) => startProbeJob({
  providerId, providerAlias: providerId,
  connectionIds: ["key-a", "key-b"], models: ["model-a"], concurrency: 2, ...options,
});

async function finish(job) {
  await vi.waitFor(() => expect(job.status).not.toBe("running"));
  return serializeJob(job);
}

describe("model probe jobs", () => {
  beforeEach(() => {
    globalThis.__nineRouterModelProbeJobs.clear();
    vi.resetAllMocks();
    mocks.getProviderConnectionById.mockImplementation(async (id) => ({ id, provider: providerId }));
    mocks.resolveConnectionProxyConfig.mockResolvedValue({});
    mocks.fetchModelContextLengths.mockResolvedValue({ "model-a": 10000 });
    mocks.probeConnectionModel.mockResolvedValue({ ok: true, latencyMs: 100 });
  });

  it("passes the mode to each key and exposes all streaming metrics to polling", async () => {
    mocks.probeConnectionModel.mockResolvedValue({
      ok: true, latencyMs: 1200, ttftMs: 200, responseDurationMs: 950,
      tokensPerSecond: 120, outputTokens: 114, tokensEstimated: true,
    });
    const job = await finish(start({ testType: "essay" }));

    expect(job).toMatchObject({ testType: "essay", completed: 2, passed: 2, failed: 0 });
    expect(mocks.probeConnectionModel).toHaveBeenCalledTimes(2);
    expect(mocks.probeConnectionModel.mock.calls[0][2]).toMatchObject({ testType: "essay", proxy: {} });
    expect(job.tasks[0]).toMatchObject({
      testType: "essay", state: "done", ttftMs: 200, responseDurationMs: 950,
      tokensPerSecond: 120, outputTokens: 114, tokensEstimated: true, contextLength: 10000,
    });
  });

  it("keeps ping and essay results independently and replaces only a rerun key", async () => {
    await finish(start());
    mocks.probeConnectionModel.mockResolvedValue({ ok: true, latencyMs: 1200, ttftMs: 200 });
    await finish(start({ testType: "essay" }));
    mocks.probeConnectionModel.mockResolvedValue({ ok: false, error: "quota exceeded", latencyMs: 20 });
    await finish(start({ connectionIds: ["key-a"] }));

    const results = getProbeResultsForProvider(providerId);
    expect(results).toHaveLength(4);
    expect(results.filter((result) => result.testType === "essay")).toHaveLength(2);
    expect(results.find((result) => result.testType === "ping" && result.connectionId === "key-a"))
      .toMatchObject({ ok: false, error: "quota exceeded", latencyMs: 20 });
    expect(results.find((result) => result.testType === "ping" && result.connectionId === "key-b"))
      .toMatchObject({ ok: true, latencyMs: 100 });
    expect(getProbeResultsForProvider("other-provider")).toEqual([]);
  });

  it("reports a connection setup error on its own task and finishes other keys", async () => {
    mocks.getProviderConnectionById.mockImplementation(async (id) => {
      if (id === "key-a") throw new Error("Proxy configuration failed");
      return { id, provider: providerId };
    });
    const job = await finish(start());

    expect(job).toMatchObject({ completed: 2, passed: 1, failed: 1 });
    expect(job.tasks[0]).toMatchObject({ state: "done", ok: false, error: "Proxy configuration failed" });
    expect(job.tasks[1]).toMatchObject({ state: "done", ok: true });
  });

  it("clears both modes for the selected model without dropping other models", async () => {
    await finish(start({ models: ["model-a", "model-b"] }));
    await finish(start({ testType: "essay", models: ["model-a", "model-b"] }));

    clearProbeResultsForProvider(providerId, "model-a");
    expect(getProbeResultsForProvider(providerId)).toHaveLength(4);
    expect(getProbeResultsForProvider(providerId).every((result) => result.modelId === "model-b")).toBe(true);
    clearProbeResultsForProvider(providerId);
    expect(getProbeResultsForProvider(providerId)).toEqual([]);
  });

  it("stops queued tasks and keeps cancelled requests out of measured results", async () => {
    let finishProbe;
    mocks.probeConnectionModel.mockImplementation(() => new Promise((resolve) => { finishProbe = resolve; }));
    const job = start({ concurrency: 1, testType: "essay" });
    await vi.waitFor(() => expect(finishProbe).toBeTypeOf("function"));
    expect(cancelJob(job.id)).toBe(true);
    finishProbe({ ok: false, error: "Cancelled" });
    const done = await finish(job);

    expect(done.status).toBe("cancelled");
    expect(done.tasks.map((task) => task.state)).toEqual(["cancelled", "cancelled"]);
    expect(getProbeResultsForProvider(providerId)).toEqual([]);
    expect(mocks.setModelProbe).not.toHaveBeenCalled();
  });
});
