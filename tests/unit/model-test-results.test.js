import { describe, it, expect } from "vitest";
import { aggregateModelTestResults } from "../../src/shared/utils/modelTestResults.js";

describe("model benchmark averages", () => {
  it("averages successful keys and keeps each failed key's message", () => {
    const result = aggregateModelTestResults([
      { ok: true, ttftMs: 100, responseDurationMs: 1000, tokensPerSecond: 20, latencyMs: 1100 },
      { ok: true, ttftMs: 300, responseDurationMs: 3000, tokensPerSecond: 40, latencyMs: 3300, tokensEstimated: true },
      { ok: false, connectionId: "bad", connectionName: "Backup key", ttftMs: 0, latencyMs: 10, error: "HTTP 401: Invalid key" },
    ]);
    expect(result).toMatchObject({ ok: false, ttftMs: 200, responseDurationMs: 2000, tokensPerSecond: 30, latencyMs: 2200, tokensEstimated: true, successCount: 2, totalCount: 3 });
    expect(result.errors).toEqual([{ connectionId: "bad", connectionName: "Backup key", error: "HTTP 401: Invalid key" }]);
  });

  it("keeps missing metrics unavailable instead of treating them as zero", () => {
    const result = aggregateModelTestResults([
      { ok: true, latencyMs: 0, ttftMs: null, tokensPerSecond: null },
      { ok: true, latencyMs: 100, ttftMs: 200, tokensPerSecond: Infinity },
    ]);
    expect(result).toMatchObject({ latencyMs: 50, ttftMs: 200, tokensPerSecond: null, responseDurationMs: null });
  });

  it("preserves partial timing on a single failed stream", () => {
    expect(aggregateModelTestResults([{ ok: false, ttftMs: 200, responseDurationMs: 300, error: "Stream interrupted" }]))
      .toMatchObject({ ok: false, ttftMs: 200, responseDurationMs: 300, successCount: 0, totalCount: 1 });
  });

  it("does not present failed requests as a successful-key average", () => {
    const result = aggregateModelTestResults([{ ok: false, latencyMs: 10 }, { ok: false, latencyMs: 20 }]);
    expect(result).toMatchObject({ ok: false, latencyMs: null, ttftMs: null, successCount: 0, totalCount: 2 });
    expect(result.errors).toHaveLength(2);
    expect(aggregateModelTestResults([]).ok).toBe(false);
  });
});
