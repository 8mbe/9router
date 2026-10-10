import { describe, expect, it, vi } from "vitest";
import { validateBulkEntry } from "../../src/shared/utils/bulkValidation.js";
import { planBulkAdd } from "../../src/shared/utils/bulkAdd.js";

function json(body) {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

const provider = "anthropic-compatible-acme";

describe("bulk key/model validation", () => {
  it.each(["claude-code", "direct"])("checks each valid bulk key's model with its %s execution mode", async (executionMode) => {
    const fetcher = vi.fn();
    if (executionMode === "claude-code") {
      fetcher.mockResolvedValueOnce(json({ ok: true, supported: true }));
    } else {
      fetcher.mockResolvedValueOnce(json({ valid: true }))
        .mockResolvedValueOnce(json({ ok: true, supported: true }));
    }
    const providerSpecificData = { executionMode };
    const result = await validateBulkEntry({ provider, apiKey: "selected-key", providerSpecificData, model: " sonnet " }, fetcher);

    expect(result).toEqual({
      keyValid: true,
      modelResult: { ok: true, supported: true, error: null },
      testStatus: "active",
    });
    if (executionMode === "direct") {
      expect(fetcher).toHaveBeenNthCalledWith(1, "/api/providers/validate", expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ provider, apiKey: "selected-key", providerSpecificData }),
      }));
    }
    expect(fetcher).toHaveBeenLastCalledWith("/api/providers/validate-model", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ provider, apiKey: "selected-key", providerSpecificData, model: "sonnet" }),
    }));
    expect(fetcher).toHaveBeenCalledTimes(executionMode === "claude-code" ? 1 : 2);
  });

  it("keeps a key unknown when its selected model fails", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ valid: true }))
      .mockResolvedValueOnce(json({ ok: false, supported: true, error: "Model unavailable" }));
    const result = await validateBulkEntry({ provider, apiKey: "model-denied-key", model: "opus" }, fetcher);
    expect(result.testStatus).toBe("unknown");
    expect(result.modelResult).toEqual({ ok: false, supported: true, error: "Model unavailable" });
  });

  it("does not send a model request for a rejected key", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ valid: false }));
    const result = await validateBulkEntry({ provider, apiKey: "invalid-key", model: "sonnet" }, fetcher);
    expect(result).toEqual({ keyValid: false, modelResult: null, testStatus: "unknown" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps the model check optional", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ valid: true }));
    const result = await validateBulkEntry({ provider, apiKey: "valid-key", model: "  " }, fetcher);
    expect(result).toEqual({ keyValid: true, modelResult: null, testStatus: "active" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not downgrade an accepted key when model probing is unsupported", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ valid: true }))
      .mockResolvedValueOnce(json({ ok: false, supported: false, error: "Model check unavailable" }));
    const result = await validateBulkEntry({ provider, apiKey: "valid-key", model: "sonnet" }, fetcher);
    expect(result.testStatus).toBe("active");
    expect(result.modelResult.supported).toBe(false);
  });

  it("saves with unknown status if a model check cannot run", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ valid: true }))
      .mockRejectedValueOnce(new Error("Connection lost"));
    const result = await validateBulkEntry({ provider, apiKey: "valid-key", model: "sonnet" }, fetcher);
    expect(result.testStatus).toBe("unknown");
    expect(result.modelResult).toEqual({ ok: false, supported: true, error: "Model check failed to run" });
  });

  it("carries each parsed entry's Cloudflare account into key validation", async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(json({ valid: true })));
    const entries = planBulkAdd(["production|key-one|account-one", "backup|key-two|account-two"], [], { isCloudflareAi: true });
    for (const entry of entries) await validateBulkEntry({ provider: "cloudflare-ai", ...entry }, fetcher);
    expect(fetcher.mock.calls.map(([, options]) => JSON.parse(options.body))).toEqual([
      { provider: "cloudflare-ai", apiKey: "key-one", providerSpecificData: { accountId: "account-one" } },
      { provider: "cloudflare-ai", apiKey: "key-two", providerSpecificData: { accountId: "account-two" } },
    ]);
  });

  it("keeps each key's own model verdict in a batch", async () => {
    const fetcher = vi.fn().mockImplementation((url, options) => {
      const body = JSON.parse(options.body);
      return Promise.resolve(json(url.endsWith("validate")
        ? { valid: true }
        : { ok: body.apiKey === "working-key", supported: true }));
    });
    const entries = planBulkAdd(["working-key", "denied-key"], ["Key 1"]);
    const results = [];
    for (const entry of entries) {
      results.push(await validateBulkEntry({ provider, ...entry, model: "sonnet", providerSpecificData: { executionMode: "claude-code" } }, fetcher));
    }
    expect(entries.map((entry) => entry.name)).toEqual(["Key 2", "Key 3"]);
    expect(results.map((result) => result.testStatus)).toEqual(["active", "unknown"]);
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("validate-model")).map(([, options]) => JSON.parse(options.body).apiKey)).toEqual(["working-key", "denied-key"]);
  });

  it("accepts a Claude Code model response even if the gateway would reject a direct key check", async () => {
    const fetcher = vi.fn().mockImplementation((url) => Promise.resolve(url.endsWith("validate-model")
      ? json({ ok: true, supported: true, latencyMs: 123 })
      : new Response(JSON.stringify({ valid: false }), { status: 403 })));
    const result = await validateBulkEntry({ provider, apiKey: "native-only-key", model: "sonnet", providerSpecificData: { executionMode: "claude-code" } }, fetcher);
    expect(result.keyValid).toBe(true);
    expect(result.testStatus).toBe("active");
    expect(result.modelResult.latencyMs).toBe(123);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe("/api/providers/validate-model");
  });

  it("keeps a failed native model check unknown without a separate direct preflight", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ ok: false, supported: true, error: "Native model denied" }));
    const result = await validateBulkEntry({ provider, apiKey: "native-denied-key", model: "sonnet", providerSpecificData: { executionMode: "claude-code" } }, fetcher);
    expect(result).toEqual({ keyValid: false, testStatus: "unknown", modelResult: { ok: false, supported: true, error: "Native model denied" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe("/api/providers/validate-model");
  });

  it("keeps the ordinary key check for Claude Code mode when no model was supplied", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ valid: true }));
    const result = await validateBulkEntry({ provider, apiKey: "native-key", model: " ", providerSpecificData: { executionMode: "claude-code" } }, fetcher);
    expect(result).toEqual({ keyValid: true, modelResult: null, testStatus: "active" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe("/api/providers/validate");
  });
});
