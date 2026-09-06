import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  extractContextLength,
  normalizeContextLength,
  formatContextLength,
} from "@/lib/modelProbe/contextLength.js";

describe("normalizeContextLength", () => {
  it("accepts positive integers and numeric strings", () => {
    expect(normalizeContextLength(4096)).toBe(4096);
    expect(normalizeContextLength("128000")).toBe(128000);
    expect(normalizeContextLength("1_000_000")).toBe(1000000);
    expect(normalizeContextLength("200,000")).toBe(200000);
    expect(normalizeContextLength(8192.7)).toBe(8192);
  });

  it("rejects absent, non-numeric, non-positive and implausible values", () => {
    for (const bad of [null, undefined, "", "abc", 0, -1, NaN, Infinity, 20_000_001]) {
      expect(normalizeContextLength(bad)).toBeNull();
    }
  });
});

describe("extractContextLength", () => {
  it("reads each gateway's own field name", () => {
    expect(extractContextLength({ context_length: 128000 })).toBe(128000);
    expect(extractContextLength({ context_window: 200000 })).toBe(200000);
    expect(extractContextLength({ max_context_length: 32768 })).toBe(32768);
    expect(extractContextLength({ max_model_len: 8192 })).toBe(8192);       // vLLM
    expect(extractContextLength({ max_input_tokens: 1047576 })).toBe(1047576); // LiteLLM
    expect(extractContextLength({ limit: { context: 262144 } })).toBe(262144); // models.dev
    expect(extractContextLength({ contextLength: 16384 })).toBe(16384);
  });

  it("prefers the served window over the model's nominal one", () => {
    // OpenRouter: top_provider.context_length is what the route actually serves.
    const model = { context_length: 1000000, top_provider: { context_length: 128000 } };
    expect(extractContextLength(model)).toBe(128000);
  });

  it("falls through a present-but-unusable field to the next candidate", () => {
    expect(extractContextLength({ top_provider: { context_length: null }, context_length: 65536 })).toBe(65536);
  });

  it("returns null when nothing advertises a window", () => {
    expect(extractContextLength({ id: "gpt-4o", object: "model" })).toBeNull();
    expect(extractContextLength(null)).toBeNull();
    expect(extractContextLength("not-an-object")).toBeNull();
  });
});

describe("formatContextLength", () => {
  it("compacts to k / M and leaves small values alone", () => {
    expect(formatContextLength(4096)).toBe("4.1k");
    expect(formatContextLength(128000)).toBe("128k");
    expect(formatContextLength(200000)).toBe("200k");
    expect(formatContextLength(1000000)).toBe("1M");
    expect(formatContextLength(2000000)).toBe("2M");
    expect(formatContextLength(512)).toBe("512");
    expect(formatContextLength(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));

const { probeConnectionModel } = await import("@/lib/modelProbe/probe.js");

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

const openAiConn = {
  provider: "openai-compatible-acme",
  apiKey: "sk-test",
  providerSpecificData: { baseUrl: "https://acme.test/v1" },
};

describe("probeConnectionModel", () => {
  beforeEach(() => { vi.restoreAllMocks(); mocks.resolveConnectionProxyConfig.mockResolvedValue({}); });

  it("sends the completion to the connection's own base URL with its own key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { choices: [{ message: { content: "hello" }, finish_reason: "stop" } ] })
    );
    const result = await probeConnectionModel(openAiConn, "acme-large", { proxy: {} });

    expect(result.ok).toBe(true);
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://acme.test/v1/chat/completions");
    expect(options.headers.Authorization).toBe("Bearer sk-test");
    expect(JSON.parse(options.body).model).toBe("acme-large");
  });

  it("reports a per-model rejection rather than a blanket key failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(404, { error: { message: "model not found" } })
    );
    const result = await probeConnectionModel(openAiConn, "acme-nonexistent", { proxy: {} });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.error).toContain("model not found");
  });

  it("treats a 200 error envelope as a failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { error: { message: "insufficient quota" } })
    );
    const result = await probeConnectionModel(openAiConn, "acme-large", { proxy: {} });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("insufficient quota");
  });

  it("soft-passes a reasoning model that spent its budget thinking", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        choices: [{ message: { content: "", reasoning: "thinking..." }, finish_reason: "length" }],
      })
    );
    const result = await probeConnectionModel(openAiConn, "acme-reasoner", { proxy: {} });
    expect(result.ok).toBe(true);
    expect(result.note).toContain("reasoning-only");
  });

  it("fails a 200 with no choices at all", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { choices: [] }));
    const result = await probeConnectionModel(openAiConn, "acme-large", { proxy: {} });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no completion choices");
  });

  it("fails cleanly when the connection has no base URL", async () => {
    const result = await probeConnectionModel({ provider: "openai-compatible-x", apiKey: "k", providerSpecificData: {} }, "m", { proxy: {} });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Connection has no base URL");
  });

  it("surfaces a network error instead of throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await probeConnectionModel(openAiConn, "acme-large", { proxy: {} });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("ECONNREFUSED");
  });
});

describe("probe job concurrency clamp", () => {
  it("keeps the in-flight count inside the allowed band", async () => {
    const { clampConcurrency, MIN_CONCURRENCY, MAX_CONCURRENCY, DEFAULT_CONCURRENCY } =
      await import("@/lib/modelProbe/jobs.js");
    expect(clampConcurrency(0)).toBe(MIN_CONCURRENCY);
    expect(clampConcurrency(-5)).toBe(MIN_CONCURRENCY);
    expect(clampConcurrency(999)).toBe(MAX_CONCURRENCY);
    expect(clampConcurrency("6")).toBe(6);
    expect(clampConcurrency("abc")).toBe(DEFAULT_CONCURRENCY);
    expect(clampConcurrency(undefined)).toBe(DEFAULT_CONCURRENCY);
  });
});

describe("probe job worker pool", () => {
  it("never exceeds the requested number of in-flight probes", async () => {
    const { __test__ } = await import("@/lib/modelProbe/jobs.js");
    const pairs = Array.from({ length: 25 }, (_, i) => i);

    let inFlight = 0;
    let peak = 0;
    const order = [];

    await __test__.runPool(pairs, 4, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Uneven durations: a chunked-batch implementation would idle here, and a
      // broken pool would let every task start at once.
      await new Promise((r) => setTimeout(r, item % 5));
      order.push(item);
      inFlight -= 1;
    });

    expect(peak).toBe(4);
    expect(order).toHaveLength(25);
    expect(new Set(order).size).toBe(25);
  });

  it("runs everything serially at concurrency 1", async () => {
    const { __test__ } = await import("@/lib/modelProbe/jobs.js");
    let inFlight = 0;
    let peak = 0;
    await __test__.runPool([1, 2, 3, 4], 1, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
    });
    expect(peak).toBe(1);
  });

  it("handles an empty task list without hanging", async () => {
    const { __test__ } = await import("@/lib/modelProbe/jobs.js");
    await expect(__test__.runPool([], 4, async () => {})).resolves.toBeUndefined();
  });
});
