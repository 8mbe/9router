// cline-free's model list. Cline's own picker shows ~25 free models; 9router used
// to expose exactly one, because the registry carried a single hardcoded id.
// The catalog now comes from Cline's API, and these pin which entries count as
// free — the part neither endpoint answers on its own.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  resolveClineFreeModels,
  resetClineFreeModelsCache,
} from "open-sse/services/clineFreeModels.js";

const CATALOG_URL = "https://api.cline.bot/api/v1/ai/cline/models";
const RECOMMENDED_URL = "https://api.cline.bot/api/v1/ai/cline/recommended-models";

const free = (id, extra = {}) => ({
  id,
  name: `${id} (free)`,
  context_length: 262144,
  pricing: { prompt: "0", completion: "0" },
  architecture: { output_modalities: ["text"] },
  ...extra,
});

const paid = (id) => ({
  id,
  name: id,
  pricing: { prompt: "0.0000009", completion: "0.000003" },
  architecture: { output_modalities: ["text"] },
});

const CATALOG = {
  data: [
    free("google/gemma-4-31b-it:free"),
    free("poolside/laguna-s-2.1:free"),
    // Zero-priced but emits audio — a chat request to it can only fail.
    free("google/lyria-3-pro-preview", { architecture: { output_modalities: ["text", "audio"] } }),
    paid("z-ai/glm-5.3-flash"),
    paid("anthropic/claude-opus-5"),
  ],
};

const FEED = {
  recommended: [{ id: "anthropic/claude-opus-5", name: "claude-opus-5" }],
  free: [
    { id: "cline-free/deepseek-v4.1-flash", name: "Deepseek-v4.1-Flash" },
    // Listed under `free` by Cline, but the catalog prices it — not free here.
    { id: "z-ai/glm-5.3-flash", name: "glm-5.3-flash" },
  ],
};

function fakeFetch(bodies = { [CATALOG_URL]: CATALOG, [RECOMMENDED_URL]: FEED }) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const body = bodies[url];
    if (!body) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
  impl.calls = calls;
  return impl;
}

beforeEach(() => resetClineFreeModelsCache());
afterEach(() => resetClineFreeModelsCache());

describe("cline-free live catalog", () => {
  it("keeps every zero-priced text model, plus Cline's own free namespace", async () => {
    const result = await resolveClineFreeModels({ token: "t", fetchImpl: fakeFetch() });
    expect(result.models.map((m) => m.id)).toEqual([
      "cline-free/deepseek-v4.1-flash",
      "google/gemma-4-31b-it:free",
      "poolside/laguna-s-2.1:free",
    ]);
  });

  it("drops priced models, including one the `free` feed lists", async () => {
    const result = await resolveClineFreeModels({ token: "t", fetchImpl: fakeFetch() });
    const ids = result.models.map((m) => m.id);
    expect(ids).not.toContain("z-ai/glm-5.3-flash");
    expect(ids).not.toContain("anthropic/claude-opus-5");
  });

  it("drops zero-priced models that answer in audio", async () => {
    const result = await resolveClineFreeModels({ token: "t", fetchImpl: fakeFetch() });
    expect(result.models.map((m) => m.id)).not.toContain("google/lyria-3-pro-preview");
  });

  it("carries the context window through for the dashboard", async () => {
    const result = await resolveClineFreeModels({ token: "t", fetchImpl: fakeFetch() });
    const gemma = result.models.find((m) => m.id === "google/gemma-4-31b-it:free");
    expect(gemma.contextLength).toBe(262144);
    expect(gemma.name).toBe("google/gemma-4-31b-it:free (free)");
  });

  it("serves the second call from cache, and refetches on forceRefresh", async () => {
    const impl = fakeFetch();
    await resolveClineFreeModels({ token: "t", fetchImpl: impl });
    await resolveClineFreeModels({ token: "t", fetchImpl: impl });
    expect(impl.calls).toHaveLength(2); // catalog + feed, once
    await resolveClineFreeModels({ token: "t", fetchImpl: impl, forceRefresh: true });
    expect(impl.calls).toHaveLength(4);
  });

  it("falls back (null) when the catalog request fails", async () => {
    const impl = fakeFetch({ [RECOMMENDED_URL]: FEED, [CATALOG_URL]: null });
    const result = await resolveClineFreeModels({ token: "t", fetchImpl: impl });
    // The feed alone still knows Cline's own free ids — a 404 catalog is not a blank list.
    expect(result.models.map((m) => m.id)).toEqual(["cline-free/deepseek-v4.1-flash"]);
  });

  it("returns null when Cline is not logged in, instead of throwing", async () => {
    const saved = process.env.CLINE_HOME;
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "cline-home-"));
    process.env.CLINE_HOME = empty;
    try {
      const impl = fakeFetch();
      expect(await resolveClineFreeModels({ fetchImpl: impl })).toBeNull();
      expect(impl.calls).toHaveLength(0); // no token → no request at all
    } finally {
      if (saved === undefined) delete process.env.CLINE_HOME;
      else process.env.CLINE_HOME = saved;
      await fs.rm(empty, { recursive: true, force: true });
    }
  });
});

describe("cline-free local session", () => {
  it("reads the access token out of the `cline auth` providers.json", async () => {
    const { readClineLocalToken } = await import("open-sse/shared/clineLocalAuth.js");
    const saved = process.env.CLINE_HOME;
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cline-home-"));
    await fs.mkdir(path.join(home, "data", "settings"), { recursive: true });
    await fs.writeFile(
      path.join(home, "data", "settings", "providers.json"),
      JSON.stringify({ providers: { cline: { settings: { auth: { accessToken: "eyJtoken" } } } } })
    );
    process.env.CLINE_HOME = home;
    try {
      expect(await readClineLocalToken()).toBe("eyJtoken");
    } finally {
      if (saved === undefined) delete process.env.CLINE_HOME;
      else process.env.CLINE_HOME = saved;
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
