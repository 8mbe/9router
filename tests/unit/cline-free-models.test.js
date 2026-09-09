import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLINE_FREE_MODELS_ENDPOINT,
  CLINE_MODELS_ENDPOINT,
  __resetClineCatalogCache,
  isClineFreeModelId,
  isClinePassModelId,
} from "../../open-sse/shared/clineModelCatalog.js";
import { resolveClineFreeModels } from "../../open-sse/services/clineFreeModels.js";
import { resolveClinepassModels } from "../../open-sse/services/clinepassModels.js";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { FREE_TIER_PROVIDERS, AI_PROVIDERS } from "@/shared/constants/providers";
import { getModelsByProviderId } from "@/shared/constants/models";
import { getProvider, getProviderNames } from "@/lib/oauth/providers/index.js";
import { getProviderIconSrc } from "@/shared/utils/providerIcon";

const originalFetch = global.fetch;

const listResponse = (ids) =>
  new Response(
    JSON.stringify({ object: "list", data: ids.map((id) => ({ id, object: "model" })) }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

const creds = { accessToken: "cline-oauth-token" };

describe("Cline free-model id predicates", () => {
  it("treats cline-free/* and *:free as free", () => {
    expect(isClineFreeModelId("cline-free/glm-5.2")).toBe(true);
    expect(isClineFreeModelId("google/gemma-4-31b-it:free")).toBe(true);
  });

  it("does not treat paid ids as free", () => {
    expect(isClineFreeModelId("anthropic/claude-opus-4.7")).toBe(false);
    expect(isClineFreeModelId("cline-pass/glm-5.2")).toBe(false);
    expect(isClineFreeModelId("openai/gpt-6-astra:batch")).toBe(false);
  });

  it("scopes cline-pass/* to the ClinePass bundle", () => {
    expect(isClinePassModelId("cline-pass/glm-5.2")).toBe(true);
    expect(isClinePassModelId("z-ai/glm-5.2")).toBe(false);
  });

  it("ignores non-string ids", () => {
    expect(isClineFreeModelId(undefined)).toBe(false);
    expect(isClinePassModelId(null)).toBe(false);
  });
});

describe("resolveClineFreeModels", () => {
  beforeEach(() => __resetClineCatalogCache());
  afterEach(() => {
    global.fetch = originalFetch;
    __resetClineCatalogCache();
  });

  it("prefers the dedicated /models/free listing verbatim", async () => {
    global.fetch = vi.fn(async (url) => {
      expect(String(url)).toBe(CLINE_FREE_MODELS_ENDPOINT);
      return listResponse(["cline-free/glm-5.2", "nvidia/nemotron-3-super-120b-a12b:free"]);
    });

    await expect(resolveClineFreeModels(creds)).resolves.toEqual({
      models: [
        { id: "cline-free/glm-5.2", name: "cline-free/glm-5.2" },
        { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "nvidia/nemotron-3-super-120b-a12b:free" },
      ],
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to /models filtered to free ids when /models/free is unavailable", async () => {
    global.fetch = vi.fn(async (url) => {
      if (String(url) === CLINE_FREE_MODELS_ENDPOINT) return new Response("nope", { status: 401 });
      return listResponse([
        "anthropic/claude-opus-4.7",
        "google/gemma-4-31b-it:free",
        "cline-free/glm-5.2",
        "openai/gpt-6-astra:batch",
      ]);
    });

    await expect(resolveClineFreeModels(creds)).resolves.toEqual({
      models: [
        { id: "google/gemma-4-31b-it:free", name: "google/gemma-4-31b-it:free" },
        { id: "cline-free/glm-5.2", name: "cline-free/glm-5.2" },
      ],
    });
  });

  it("sends the workos: prefix for OAuth tokens and a plain bearer for API keys", async () => {
    const seen = [];
    global.fetch = vi.fn(async (url, init) => {
      seen.push(init.headers.Authorization);
      return listResponse(["cline-free/glm-5.2"]);
    });

    await resolveClineFreeModels({ accessToken: "oauth-tok" });
    __resetClineCatalogCache();
    await resolveClineFreeModels({ apiKey: "key-tok" });

    expect(seen).toEqual(["Bearer workos:oauth-tok", "Bearer key-tok"]);
  });

  it("caches the catalog and dedups concurrent callers", async () => {
    global.fetch = vi.fn(async () => listResponse(["cline-free/glm-5.2"]));

    const [a, b] = await Promise.all([resolveClineFreeModels(creds), resolveClineFreeModels(creds)]);
    await resolveClineFreeModels(creds);

    expect(a).toEqual(b);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not cache failures", async () => {
    global.fetch = vi.fn(async () => new Response("boom", { status: 500 }));
    await expect(resolveClineFreeModels(creds)).resolves.toBeNull();
    await expect(resolveClineFreeModels(creds)).resolves.toBeNull();
    // 2 calls per attempt: /models/free then the /models fallback
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  it("returns null without credentials and never hits the network", async () => {
    global.fetch = vi.fn();
    await expect(resolveClineFreeModels({})).resolves.toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("resolveClinepassModels", () => {
  beforeEach(() => __resetClineCatalogCache());
  afterEach(() => {
    global.fetch = originalFetch;
    __resetClineCatalogCache();
  });

  it("keeps cline-pass/* and cline-free/* but not paid or :free ids", async () => {
    global.fetch = vi.fn(async (url) => {
      expect(String(url)).toBe(CLINE_MODELS_ENDPOINT);
      return listResponse([
        "cline-pass/glm-5.2",
        "cline-free/glm-5.2",
        "anthropic/claude-opus-4.7",
        "google/gemma-4-31b-it:free",
      ]);
    });

    await expect(resolveClinepassModels(creds)).resolves.toEqual({
      models: [
        { id: "cline-pass/glm-5.2", name: "cline-pass/glm-5.2" },
        { id: "cline-free/glm-5.2", name: "cline-free/glm-5.2" },
      ],
    });
  });

  it("returns null when the catalog carries no ClinePass models", async () => {
    global.fetch = vi.fn(async () => listResponse(["anthropic/claude-opus-4.7"]));
    await expect(resolveClinepassModels(creds)).resolves.toBeNull();
  });
});

describe("cline-free registry entry", () => {
  const entry = REGISTRY.find((r) => r.id === "cline-free");

  it("is registered with a free-tier, OAuth-capable shape", () => {
    expect(entry).toBeTruthy();
    expect(entry.category).toBe("freeTier");
    expect(entry.hasFree).toBe(true);
    expect(entry.hasOAuth).toBe(true);
    expect(entry.authModes).toEqual(["oauth", "apikey"]);
  });

  it("shares Cline's transport, auth hook and refresh endpoint", () => {
    const cline = REGISTRY.find((r) => r.id === "cline");
    expect(entry.transport.baseUrl).toBe(cline.transport.baseUrl);
    expect(entry.transport.auth.hooks).toContain("clineHeaders");
    expect(entry.oauth.refreshUrl).toBe(cline.oauth.refreshUrl);
  });

  it("lists only free-tier fallback models", () => {
    expect(entry.models.length).toBeGreaterThan(0);
    for (const m of entry.models) expect(isClineFreeModelId(m.id)).toBe(true);
  });

  it("does not collide with the cline/clinepass aliases", () => {
    const others = REGISTRY.filter((r) => r.id !== "cline-free")
      .flatMap((r) => [r.id, r.alias, r.uiAlias, ...(r.aliases || [])])
      .filter(Boolean);
    for (const token of ["cline-free", entry.alias, ...entry.aliases]) {
      expect(others).not.toContain(token);
    }
  });
});

describe("cline-free app wiring", () => {
  it("appears in the dashboard free-tier group", () => {
    expect(FREE_TIER_PROVIDERS["cline-free"]?.name).toBe("Cline Free");
    expect(FREE_TIER_PROVIDERS["cline-free"].hasFree).toBe(true);
    expect(FREE_TIER_PROVIDERS["cline-free"].hasOAuth).toBe(true);
    expect(AI_PROVIDERS["cline-free"]).toBeTruthy();
  });

  it("resolves its models through the clf alias", () => {
    const models = getModelsByProviderId("cline-free");
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => isClineFreeModelId(m.id))).toBe(true);
  });

  it("has an OAuth handler pointed at Cline's authorize endpoint", () => {
    expect(getProviderNames()).toContain("cline-free");
    const provider = getProvider("cline-free");
    const url = provider.buildAuthUrl(provider.config, "http://localhost:20128/cb");
    expect(url).toContain("https://api.cline.bot/api/v1/auth/authorize");
    expect(url).toContain("client_type=extension");
  });

  it("reuses the cline icon rather than 404ing on its own", () => {
    expect(getProviderIconSrc("cline-free")).toBe("/providers/cline.png");
  });
});
