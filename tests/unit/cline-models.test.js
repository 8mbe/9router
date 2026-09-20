// Cline's free tier was invisible in 9router: /api/v1/models lists the ~450
// models the gateway routes, but it says nothing about who pays, and the free
// plan's own `cline-free/*` ids are not even in it. The recommended feed is the
// authority on what is free. These pin the merge.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveClineModels, resolveClinepassModels } from "open-sse/services/clinepassModels.js";

const MODELS_URL = "https://api.cline.bot/api/v1/models";
const FEED_URL = "https://api.cline.bot/api/v1/ai/cline/recommended-models";

const CATALOG = {
  data: [
    { id: "anthropic/claude-opus-5", name: "Claude Opus 5" },
    { id: "google/gemma-4-31b-it:free", name: "Google: Gemma 4 31B (free)" },
    { id: "nvidia/nemotron-3-ultra-550b-a55b:free", name: "NVIDIA: Nemotron 3 Ultra (free)" },
    { id: "cline-pass/glm-5.3", name: "cline-pass/glm-5.3" },
  ],
};

const FEED = {
  recommended: [{ id: "openai/gpt-6-astra", name: "gpt-6-astra" }],
  free: [
    { id: "cline-free/deepseek-v4.1-flash", name: "Deepseek-v4.1-Flash" },
    // Priced in the catalog, free on Cline's plan — the feed is what decides.
    { id: "z-ai/glm-5.3-flash", name: "glm-5.3-flash" },
    { id: "cline-free/solar-pro4", name: "Solar Pro 4" },
    // A `:free` id Cline really serves, also returned by /models — it must
    // survive the `:free` cull and not end up in the list twice.
    { id: "google/gemma-4-31b-it:free", name: "Google: Gemma 4 31B (free)" },
  ],
};

function stubFetch(bodies) {
  const fetchMock = vi.fn(async (url) => {
    const body = bodies[url];
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("cline live model catalog", () => {
  it("adds the free-plan ids that /models never returns", async () => {
    stubFetch({ [MODELS_URL]: CATALOG, [FEED_URL]: FEED });
    const { models } = await resolveClineModels({ accessToken: "eyJtoken" });
    const ids = models.map((m) => m.id);
    expect(ids).toContain("cline-free/deepseek-v4.1-flash");
    expect(ids).toContain("cline-free/solar-pro4");
    expect(ids).toContain("google/gemma-4-31b-it:free");
  });

  it("keeps a feed model the catalog prices — Cline serves it free anyway", async () => {
    stubFetch({ [MODELS_URL]: CATALOG, [FEED_URL]: FEED });
    const { models } = await resolveClineModels({ accessToken: "eyJtoken" });
    expect(models.map((m) => m.id)).toContain("z-ai/glm-5.3-flash");
  });

  it("puts the free plan first, so it is not buried under 400+ paid ids", async () => {
    stubFetch({ [MODELS_URL]: CATALOG, [FEED_URL]: FEED });
    const { models } = await resolveClineModels({ accessToken: "eyJtoken" });
    expect(models.slice(0, 4).map((m) => m.id)).toEqual([
      "cline-free/deepseek-v4.1-flash",
      "z-ai/glm-5.3-flash",
      "cline-free/solar-pro4",
      "google/gemma-4-31b-it:free",
    ]);
  });

  it("lists a model the feed and the catalog share exactly once", async () => {
    stubFetch({ [MODELS_URL]: CATALOG, [FEED_URL]: FEED });
    const { models } = await resolveClineModels({ accessToken: "eyJtoken" });
    const shared = models.filter((m) => m.id === "google/gemma-4-31b-it:free");
    expect(shared).toHaveLength(1);
  });

  it("drops the vendors' `:free` ids, which mostly just fail on first use", async () => {
    stubFetch({ [MODELS_URL]: CATALOG, [FEED_URL]: FEED });
    const ids = (await resolveClineModels({ accessToken: "eyJtoken" })).models.map((m) => m.id);
    expect(ids).not.toContain("nvidia/nemotron-3-ultra-550b-a55b:free");
    // …unless Cline's own free feed names it.
    expect(ids).toContain("google/gemma-4-31b-it:free");
  });

  it("still returns the catalog when the feed request fails", async () => {
    stubFetch({ [MODELS_URL]: CATALOG });
    const { models } = await resolveClineModels({ accessToken: "eyJtoken" });
    expect(models.map((m) => m.id)).toEqual([
      "anthropic/claude-opus-5",
      "cline-pass/glm-5.3",
    ]);
  });

  it("still returns the free plan when the catalog request fails", async () => {
    stubFetch({ [FEED_URL]: FEED });
    const { models } = await resolveClineModels({ accessToken: "eyJtoken" });
    expect(models.map((m) => m.id)).toEqual([
      "cline-free/deepseek-v4.1-flash",
      "z-ai/glm-5.3-flash",
      "cline-free/solar-pro4",
      "google/gemma-4-31b-it:free",
    ]);
  });

  it("returns null when both requests fail, so the caller falls back to static", async () => {
    stubFetch({});
    expect(await resolveClineModels({ accessToken: "eyJtoken" })).toBeNull();
  });

  it("asks for nothing without a credential", async () => {
    const fetchMock = stubFetch({ [MODELS_URL]: CATALOG, [FEED_URL]: FEED });
    expect(await resolveClineModels({})).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("clinepass catalog is unchanged", () => {
  it("keeps only cline-pass/* and never picks up the free plan", async () => {
    stubFetch({ [MODELS_URL]: CATALOG, [FEED_URL]: FEED });
    const { models } = await resolveClinepassModels({ accessToken: "eyJtoken" });
    expect(models.map((m) => m.id)).toEqual(["cline-pass/glm-5.3"]);
  });
});
