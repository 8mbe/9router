// Cline's free tier was invisible in 9router: /api/v1/models lists the ~450
// models the gateway routes, but the free plan's own `cline-free/*` ids are not
// in it — they come from the recommended feed. These pin the merge.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveClineModels, resolveClinepassModels } from "open-sse/services/clinepassModels.js";

const MODELS_URL = "https://api.cline.bot/api/v1/models";
const FEED_URL = "https://api.cline.bot/api/v1/ai/cline/recommended-models";

const CATALOG = {
  data: [
    { id: "anthropic/claude-opus-5", name: "Claude Opus 5" },
    { id: "google/gemma-4-31b-it:free", name: "Google: Gemma 4 31B (free)" },
    { id: "cline-pass/glm-5.3", name: "cline-pass/glm-5.3" },
  ],
};

const FEED = {
  recommended: [{ id: "openai/gpt-6-astra", name: "gpt-6-astra" }],
  free: [
    { id: "cline-free/deepseek-v4.1-flash", name: "Deepseek-v4.1-Flash" },
    { id: "cline-free/solar-pro4", name: "Solar Pro 4" },
    // Cline lists this one under `free` as well, but it is an ordinary catalog
    // id — it must not be duplicated when /models already returned it.
    { id: "anthropic/claude-opus-5", name: "Claude Opus 5" },
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

  it("puts the free plan first, so it is not buried under 400+ paid ids", async () => {
    stubFetch({ [MODELS_URL]: CATALOG, [FEED_URL]: FEED });
    const { models } = await resolveClineModels({ accessToken: "eyJtoken" });
    expect(models.slice(0, 2).map((m) => m.id)).toEqual([
      "cline-free/deepseek-v4.1-flash",
      "cline-free/solar-pro4",
    ]);
  });

  it("lists a model the feed and the catalog share exactly once", async () => {
    stubFetch({ [MODELS_URL]: CATALOG, [FEED_URL]: FEED });
    const { models } = await resolveClineModels({ accessToken: "eyJtoken" });
    const opus = models.filter((m) => m.id === "anthropic/claude-opus-5");
    expect(opus).toHaveLength(1);
  });

  it("still returns the catalog when the feed request fails", async () => {
    stubFetch({ [MODELS_URL]: CATALOG });
    const { models } = await resolveClineModels({ accessToken: "eyJtoken" });
    expect(models.map((m) => m.id)).toEqual([
      "anthropic/claude-opus-5",
      "google/gemma-4-31b-it:free",
      "cline-pass/glm-5.3",
    ]);
  });

  it("still returns the free plan when the catalog request fails", async () => {
    stubFetch({ [FEED_URL]: FEED });
    const { models } = await resolveClineModels({ accessToken: "eyJtoken" });
    expect(models.map((m) => m.id)).toEqual([
      "cline-free/deepseek-v4.1-flash",
      "cline-free/solar-pro4",
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
