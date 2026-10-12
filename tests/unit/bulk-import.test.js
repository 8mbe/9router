import { describe, expect, it, vi } from "vitest";
import { importBulkApiKeys } from "@/shared/utils/bulkImport";
import { planBulkAdd } from "@/shared/utils/bulkAdd";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const entries = planBulkAdd(["test-key-a", "Production|test-key-b", "test-key-c"], ["Key 1"]);

describe("bulk API-key import", () => {
  it("validates and saves each key with collision-free names and shared connection settings", async () => {
    const fetcher = vi.fn(async (url) => url.endsWith("/validate") ? json({ valid: true }) : json({ connection: {} }, 201));
    const progress = vi.fn();
    const result = await importBulkApiKeys({ provider: "treg", entries, priority: 3, proxyPoolId: "pool-a", providerSpecificData: { org: "team" }, onProgress: progress }, fetcher);

    expect(result).toEqual({ success: 3, failed: 0, modelsPassed: 0, modelsFailed: 0, failedIndexes: [] });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(Array.from({ length: 3 }, () => ["/api/providers/validate", "/api/providers"]).flat());
    const saves = fetcher.mock.calls.filter(([url]) => url === "/api/providers").map(([, init]) => JSON.parse(init.body));
    expect(saves.map((body) => body.name)).toEqual(["Key 2", "Production 1", "Key 3"]);
    expect(saves.every((body) => body.provider === "treg" && body.testStatus === "active" && body.priority === 3 && body.proxyPoolId === "pool-a" && body.providerSpecificData.org === "team")).toBe(true);
    expect(progress.mock.calls.map(([value]) => value)).toEqual([{ completed: 1, total: 3 }, { completed: 2, total: 3 }, { completed: 3, total: 3 }]);
  });

  it("continues after failed saves and returns only failed indexes for retry", async () => {
    let saves = 0;
    const fetcher = vi.fn(async (url) => {
      if (url.endsWith("/validate")) return json({ valid: true });
      saves++;
      return saves === 2 ? json({ error: "Save failed" }, 500) : json({}, 201);
    });
    const result = await importBulkApiKeys({ provider: "treg", entries }, fetcher);

    expect(result).toMatchObject({ success: 2, failed: 1, failedIndexes: [1] });
    expect(entries.filter((_, index) => result.failedIndexes.includes(index)).map((entry) => entry.apiKey)).toEqual(["test-key-b"]);
    expect(saves).toBe(3);
  });

  it("keeps invalid or unreachable keys with unknown status, matching single-key saves", async () => {
    let checks = 0;
    const fetcher = vi.fn(async (url) => {
      if (url.endsWith("/validate")) {
        checks++;
        if (checks === 2) throw new Error("Network unavailable");
        return json({ valid: false });
      }
      return json({}, 201);
    });
    const result = await importBulkApiKeys({ provider: "treg", entries }, fetcher);

    expect(result.success).toBe(3);
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/providers").every(([, init]) => JSON.parse(init.body).testStatus === "unknown")).toBe(true);
  });

  it("handles a network save failure without retrying successful writes", async () => {
    const fetcher = vi.fn(async (url, init) => {
      if (url.endsWith("/validate")) return json({ valid: true });
      if (JSON.parse(init.body).apiKey === "test-key-a") throw new Error("Lost connection");
      return json({}, 201);
    });
    const result = await importBulkApiKeys({ provider: "treg", entries }, fetcher);

    expect(result).toMatchObject({ success: 2, failed: 1, failedIndexes: [0] });
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/providers")).toHaveLength(3);
  });

  it("retains per-key provider data alongside shared data", async () => {
    const fetcher = vi.fn(async (url) => url.endsWith("/validate") ? json({ valid: true }) : json({}, 201));
    const cloudflareEntries = planBulkAdd(["Production|test-key|entry-account"], [], { isCloudflareAi: true });
    await importBulkApiKeys({ provider: "cloudflare-ai", entries: cloudflareEntries, providerSpecificData: { accountId: "shared-account", region: "us" } }, fetcher);

    expect(JSON.parse(fetcher.mock.calls[0][1].body).providerSpecificData).toEqual({ accountId: "entry-account", region: "us" });
    expect(JSON.parse(fetcher.mock.calls[1][1].body).providerSpecificData).toEqual({ accountId: "entry-account", region: "us" });
  });

  it("records model checks separately and saves rejected models as unknown", async () => {
    const fetcher = vi.fn(async (url) => {
      if (url.endsWith("/validate")) return json({ valid: true });
      if (url.endsWith("/validate-model")) return json({ ok: false, supported: true, error: "Model unavailable" });
      return json({}, 201);
    });
    const result = await importBulkApiKeys({ provider: "openai-compatible-test", entries: entries.slice(0, 1), defaultModel: "test-model" }, fetcher);

    expect(result).toMatchObject({ success: 1, failed: 0, modelsPassed: 0, modelsFailed: 1 });
    expect(JSON.parse(fetcher.mock.calls.at(-1)[1].body)).toMatchObject({ defaultModel: "test-model", testStatus: "unknown" });
  });

  it("does not contact the backend for an empty batch", async () => {
    const fetcher = vi.fn();
    const result = await importBulkApiKeys({ provider: "treg", entries: [] }, fetcher);
    expect(result).toMatchObject({ success: 0, failed: 0, failedIndexes: [] });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
