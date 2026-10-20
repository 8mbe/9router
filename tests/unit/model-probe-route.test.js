import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(), getProviderConnections: vi.fn(), getCustomModels: vi.fn(),
  getModelProbes: vi.fn(), clearModelProbes: vi.fn(), invalidateProbeHints: vi.fn(),
  startProbeJob: vi.fn(), getJob: vi.fn(), cancelJob: vi.fn(),
  findLatestJobForProvider: vi.fn(), getProbeResultsForProvider: vi.fn(), clearProbeResultsForProvider: vi.fn(),
}));

vi.mock("@/models", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  getProviderConnections: mocks.getProviderConnections,
  getCustomModels: mocks.getCustomModels,
}));
vi.mock("@/lib/db/repos/modelProbesRepo.js", () => ({
  getModelProbes: mocks.getModelProbes, clearModelProbes: mocks.clearModelProbes,
}));
vi.mock("@/lib/modelProbe/routingHints", () => ({ invalidateProbeHints: mocks.invalidateProbeHints }));
vi.mock("@/lib/modelProbe/jobs", () => ({
  startProbeJob: mocks.startProbeJob, getJob: mocks.getJob, cancelJob: mocks.cancelJob,
  findLatestJobForProvider: mocks.findLatestJobForProvider,
  getProbeResultsForProvider: mocks.getProbeResultsForProvider,
  clearProbeResultsForProvider: mocks.clearProbeResultsForProvider,
  serializeJob: (job) => job,
  clampConcurrency: (value) => value,
  MAX_CONCURRENCY: 16, DEFAULT_CONCURRENCY: 4,
}));
vi.mock("next/server", () => ({ NextResponse: { json: (body, init = {}) => Response.json(body, init) } }));

const { POST, GET, DELETE } = await import("@/app/api/providers/[id]/model-probe/route.js");
const providerId = "openai-compatible-example";
const url = "http://localhost/api/providers/key-a/model-probe";
const context = { params: Promise.resolve({ id: "key-a" }) };
const request = (body) => new Request(url, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

describe("model probe route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getProviderConnectionById.mockResolvedValue({ id: "key-a", provider: providerId });
    mocks.getProviderConnections.mockResolvedValue([{ id: "key-a" }, { id: "key-b" }]);
    mocks.getModelProbes.mockResolvedValue([]);
    mocks.getProbeResultsForProvider.mockReturnValue([]);
    mocks.findLatestJobForProvider.mockReturnValue(null);
    mocks.startProbeJob.mockImplementation((options) => ({ jobId: "job", ...options }));
  });

  it.each(["ping", "essay"])("starts a %s job for all active keys", async (testType) => {
    const response = await POST(request({ models: ["model-a"], testType }), context);
    expect(response.status).toBe(200);
    expect(mocks.startProbeJob).toHaveBeenCalledWith(expect.objectContaining({
      testType, models: ["model-a"], connectionIds: ["key-a", "key-b"],
    }));
    expect((await response.json()).job.testType).toBe(testType);
  });

  it("rejects unknown modes before starting a job", async () => {
    const response = await POST(request({ models: ["model-a"], testType: "invalid" }), context);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Test type must be ping or essay");
    expect(mocks.startProbeJob).not.toHaveBeenCalled();
  });

  it("restores results from both test types", async () => {
    const results = [
      { modelId: "model-a", connectionId: "key-a", testType: "ping", ok: true, latencyMs: 20 },
      { modelId: "model-a", connectionId: "key-a", testType: "essay", ok: true, ttftMs: 30 },
    ];
    mocks.getProbeResultsForProvider.mockReturnValue(results);
    expect(await (await GET(new Request(url), context)).json()).toMatchObject({ results });
    expect(mocks.getProbeResultsForProvider).toHaveBeenCalledWith(providerId);
  });

  it("clears recent measured results along with stored verdicts", async () => {
    mocks.clearModelProbes.mockResolvedValue(2);
    expect((await DELETE(new Request(`${url}?modelId=model-a`, { method: "DELETE" }), context)).status).toBe(200);
    expect(mocks.clearProbeResultsForProvider).toHaveBeenCalledWith(providerId, "model-a");
  });

  it("does not expose or cancel another provider's job", async () => {
    mocks.getJob.mockReturnValue({ providerId: "other-provider" });
    expect((await GET(new Request(`${url}?jobId=other-job`), context)).status).toBe(404);
    expect((await DELETE(new Request(`${url}?jobId=other-job`, { method: "DELETE" }), context)).status).toBe(404);
    expect(mocks.cancelJob).not.toHaveBeenCalled();
  });
});
