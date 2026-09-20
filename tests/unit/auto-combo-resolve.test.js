import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetAutoComboHealth, markAutoComboUnavailable } from "open-sse/services/autoComboHealth.js";

// Resolution turns a bare model name into an ordered fallback chain across the
// providers that actually carry the model. The DB, the provider catalog and the
// warm upstream cache are all stubbed so the ordering rules are what is tested.

const state = {
  connections: [],
  settings: {},
  aliases: {},
  customModels: [],
  disabled: {},
  upstream: {},
};

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: async () => state.connections.filter((c) => c.isActive !== false),
  getSettings: async () => state.settings,
  getModelAliases: async () => state.aliases,
  getCustomModels: async () => state.customModels,
}));

vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: async () => state.disabled,
}));

vi.mock("@/lib/modelCatalog/upstreamCache", () => ({
  peekCachedUpstream: (key) => state.upstream[key] ?? null,
}));

vi.mock("@/shared/constants/models", () => ({
  PROVIDER_MODELS: {
    "prov-a": [{ id: "gpt-5.6-sol" }, { id: "claude-sonnet-4.5" }],
    "prov-b": [{ id: "gpt-5-6-sol" }],
    "prov-c": [{ id: "gpt-5-6-solm" }],
    "prov-d": [{ id: "gemini-3-pro" }],
    "prov-free": [{ id: "gpt-5.6-sol" }],
  },
  PROVIDER_ID_TO_ALIAS: {
    "provider-a": "prov-a",
    "provider-b": "prov-b",
    "provider-c": "prov-c",
    "provider-d": "prov-d",
    "provider-free": "prov-free",
  },
}));

vi.mock("@/shared/constants/providers", () => ({
  FREE_PROVIDERS: { "provider-free": { id: "provider-free", alias: "prov-free", noAuth: true } },
  getProviderAlias: (id) => ({
    "provider-a": "prov-a",
    "provider-b": "prov-b",
    "provider-c": "prov-c",
    "provider-d": "prov-d",
    "provider-free": "prov-free",
  }[id] || id),
}));

const { resolveAutoCombo } = await import("@/sse/services/autoCombo");

const conn = (provider, extra = {}) => ({
  id: `${provider}-conn`,
  provider,
  isActive: true,
  providerSpecificData: {},
  ...extra,
});

beforeEach(() => {
  resetAutoComboHealth();
  state.connections = [conn("provider-a"), conn("provider-b"), conn("provider-c"), conn("provider-d")];
  state.settings = {};
  state.aliases = {};
  state.customModels = [];
  state.disabled = {};
  state.upstream = {};
});

describe("resolveAutoCombo", () => {
  it("collects every provider carrying the model, best match first", async () => {
    const result = await resolveAutoCombo("gpt-5.6-sol");
    expect(result.models).toEqual([
      "prov-a/gpt-5.6-sol",      // exact
      "prov-free/gpt-5.6-sol",   // exact, but no-auth ranks behind credentialed
      "prov-b/gpt-5-6-sol",      // canonical
      "prov-c/gpt-5-6-solm",     // variant
    ]);
    expect(result.models).not.toContain("prov-d/gemini-3-pro");
  });

  it("returns null for a provider-prefixed model", async () => {
    expect(await resolveAutoCombo("prov-a/gpt-5.6-sol")).toBeNull();
  });

  it("returns null when no provider carries the model", async () => {
    expect(await resolveAutoCombo("some-unknown-model-xyz")).toBeNull();
  });

  it("stands aside for an explicit alias", async () => {
    state.aliases = { "gpt-5.6-sol": "prov-b/gpt-5-6-sol" };
    expect(await resolveAutoCombo("gpt-5.6-sol")).toBeNull();
  });

  it("can be turned off", async () => {
    state.settings = { autoComboEnabled: false };
    expect(await resolveAutoCombo("gpt-5.6-sol")).toBeNull();
  });

  it("restricts membership to exact spellings when fuzzy is off", async () => {
    state.settings = { autoComboFuzzy: false };
    const result = await resolveAutoCombo("gpt-5.6-sol");
    expect(result.models).toEqual([
      "prov-a/gpt-5.6-sol",
      "prov-free/gpt-5.6-sol",
      "prov-b/gpt-5-6-sol",
    ]);
  });

  it("drops benched members and reports them", async () => {
    markAutoComboUnavailable("prov-a/gpt-5.6-sol", 429);
    const result = await resolveAutoCombo("gpt-5.6-sol");
    expect(result.models).not.toContain("prov-a/gpt-5.6-sol");
    expect(result.benched).toEqual(["prov-a/gpt-5.6-sol"]);
  });

  it("still tries benched members when every provider is benched", async () => {
    for (const m of ["prov-a/gpt-5.6-sol", "prov-b/gpt-5-6-sol", "prov-c/gpt-5-6-solm", "prov-free/gpt-5.6-sol"]) {
      markAutoComboUnavailable(m, 500);
    }
    const result = await resolveAutoCombo("gpt-5.6-sol");
    expect(result.models.length).toBe(4);
    expect(result.benched).toEqual([]);
  });

  it("honours an explicit provider priority", async () => {
    state.settings = { autoComboPriority: ["provider-c", "provider-b"] };
    const result = await resolveAutoCombo("gpt-5.6-sol");
    // Priority breaks ties within a match tier; it never promotes a worse match.
    expect(result.models[0]).toBe("prov-a/gpt-5.6-sol");
    expect(result.models.indexOf("prov-c/gpt-5-6-solm")).toBeGreaterThan(
      result.models.indexOf("prov-b/gpt-5-6-sol")
    );
  });

  it("caps the number of members", async () => {
    state.settings = { autoComboMaxMembers: 2 };
    const result = await resolveAutoCombo("gpt-5.6-sol");
    expect(result.models).toEqual(["prov-a/gpt-5.6-sol", "prov-free/gpt-5.6-sol"]);
  });

  it("skips models the dashboard disabled for that provider", async () => {
    state.disabled = { "prov-a": ["gpt-5.6-sol"] };
    const result = await resolveAutoCombo("gpt-5.6-sol");
    expect(result.models).not.toContain("prov-a/gpt-5.6-sol");
  });

  it("skips inactive connections", async () => {
    state.connections = state.connections.map((c) =>
      c.provider === "provider-a" ? { ...c, isActive: false } : c
    );
    const result = await resolveAutoCombo("gpt-5.6-sol");
    expect(result.models).not.toContain("prov-a/gpt-5.6-sol");
  });

  it("prefers an account's pinned model list over the static catalog", async () => {
    state.connections = [conn("provider-a", { providerSpecificData: { enabledModels: ["claude-sonnet-4.5"] } })];
    const result = await resolveAutoCombo("gpt-5.6-sol");
    expect(result.models.some((m) => m.startsWith("prov-a/"))).toBe(false);
  });

  it("uses a warm upstream catalog when one is cached", async () => {
    state.connections = [conn("provider-a")];
    state.upstream["live:provider-a-conn:provider-a"] = [{ id: "gpt-5.6-sol-turbo" }];
    const result = await resolveAutoCombo("gpt-5.6-sol");
    // prov-free is a no-auth provider: it needs no connection and is always in.
    expect(result.models).toEqual(["prov-free/gpt-5.6-sol", "prov-a/gpt-5.6-sol-turbo"]);
  });

  it("addresses a provider node by its custom prefix", async () => {
    state.connections = [conn("provider-a", { providerSpecificData: { prefix: "mynode" } })];
    const result = await resolveAutoCombo("gpt-5.6-sol");
    expect(result.models).toEqual(["mynode/gpt-5.6-sol", "prov-free/gpt-5.6-sol"]);
  });

  it("includes custom models registered against a provider", async () => {
    state.connections = [conn("provider-d")];
    state.customModels = [{ id: "gpt-5.6-sol", providerAlias: "prov-d" }];
    const result = await resolveAutoCombo("gpt-5.6-sol");
    expect(result.models).toContain("prov-d/gpt-5.6-sol");
  });
});
