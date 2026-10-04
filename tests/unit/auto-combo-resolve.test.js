import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetAutoComboHealth, markAutoComboUnavailable, markAutoComboHealthy } from "open-sse/services/autoComboHealth.js";

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
  probes: new Map(),
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

vi.mock("@/lib/modelProbe/routingHints", async (importOriginal) => ({
  ...await importOriginal(),
  getProbeHints: async () => state.probes,
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

const { resolveAutoCombo, inspectAutoComboMembers } = await import("@/sse/services/autoCombo");

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
  state.probes = new Map();
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

  it("retains failed members after untested members and reports them", async () => {
    markAutoComboUnavailable("prov-a/gpt-5.6-sol", 429);
    const result = await resolveAutoCombo("gpt-5.6-sol");
    expect(result.models.at(-1)).toBe("prov-a/gpt-5.6-sol");
    expect(result.benched).toEqual(["prov-a/gpt-5.6-sol"]);
  });

  it("still tries benched members when every provider is benched", async () => {
    for (const m of ["prov-a/gpt-5.6-sol", "prov-b/gpt-5-6-sol", "prov-c/gpt-5-6-solm", "prov-free/gpt-5.6-sol"]) {
      markAutoComboUnavailable(m, 500);
    }
    const result = await resolveAutoCombo("gpt-5.6-sol");
    expect(result.models.length).toBe(4);
    expect(result.benched).toEqual(result.models);
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

  it.each([2, 8, 0])("includes every match despite a legacy member cap of %s", async (cap) => {
    state.settings = { autoComboMaxMembers: cap };
    const result = await resolveAutoCombo("gpt-5.6-sol");
    expect(result.models).toHaveLength(4);
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

  it("collects every Claude Opus variant, including older versions and Cursor spellings", async () => {
    const opusModels = [
      "claude-opus-5", "claude-opus-5-thinking", "claude-opus-5-agentic",
      "claude-opus-5-thinking-agentic", "claude-opus-5.5", "claude-opus-4.8",
      "claude-opus-4.7-max", "claude-opus-4.7-low", "claude-4.5-opus-high-thinking",
      "anthropic/claude-opus-4-20250514", "us.anthropic.claude-opus-4-20250514-v1:0",
    ];
    state.connections = [conn("provider-a", {
      providerSpecificData: { enabledModels: [...opusModels, "claude-sonnet-5", "claude-haiku-5"] },
    })];
    state.settings = { autoComboMaxMembers: 8 };

    const result = await resolveAutoCombo("claude-opus-5");

    expect(result.models).toHaveLength(opusModels.length);
    expect(new Set(result.models)).toEqual(new Set(opusModels.map((id) => `prov-a/${id}`)));
    expect(result.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ member: "prov-a/claude-opus-5-agentic", providerId: "provider-a", modelId: "claude-opus-5-agentic", status: "untested" }),
    ]));
  });

  it("unions pinned and warm catalogs across all active accounts of a provider", async () => {
    state.connections = [
      conn("provider-a", { id: "first", providerSpecificData: { enabledModels: ["claude-sonnet-5"] } }),
      conn("provider-a", { id: "second", providerSpecificData: { enabledModels: ["claude-opus-5", "claude-opus-5-thinking"] } }),
      conn("provider-a", { id: "third" }),
      conn("provider-a", { id: "inactive", isActive: false, providerSpecificData: { enabledModels: ["claude-opus-5-disabled"] } }),
    ];
    state.upstream["live:third:provider-a"] = [{ id: "claude-opus-4.7" }];

    const result = await resolveAutoCombo("claude-opus-5");

    expect(result.models).toEqual(["prov-a/claude-opus-5", "prov-a/claude-opus-5-thinking", "prov-a/claude-opus-4.7"]);
  });

  it("keeps family versions and decorated variants out when fuzzy matching is disabled", async () => {
    state.connections = [conn("provider-a", { providerSpecificData: { enabledModels: [
      "claude-opus-5", "claude-opus-5-thinking", "claude-opus-4.7", "CLAUDE_OPUS_5",
    ] } })];
    state.settings = { autoComboFuzzy: false };

    expect((await resolveAutoCombo("claude-opus-5")).models).toEqual(["prov-a/claude-opus-5", "prov-a/CLAUDE_OPUS_5"]);
  });

  it("prefers successful fuzzy members over untested exact matches and retains failure order", async () => {
    markAutoComboHealthy("prov-c/gpt-5-6-solm");
    markAutoComboUnavailable("prov-a/gpt-5.6-sol", 429, "quota", Date.now() + 60 * 60 * 1000);
    markAutoComboUnavailable("prov-b/gpt-5-6-sol", 503, "down", Date.now() + 10 * 60 * 1000);

    const result = await resolveAutoCombo("gpt-5.6-sol");

    expect(result.models).toEqual(["prov-c/gpt-5-6-solm", "prov-free/gpt-5.6-sol", "prov-a/gpt-5.6-sol", "prov-b/gpt-5-6-sol"]);
    expect(result.members.map(({ status }) => status)).toEqual(["working", "untested", "not_working", "not_working"]);
  });

  it("uses model-specific persisted probes and any working account to rank providers", async () => {
    state.connections.push(conn("provider-c", { id: "provider-c-other" }));
    state.probes = new Map([
      ["provider-a-conn::gpt-5.6-sol", { ok: false, testedAt: Date.now() }],
      ["provider-c-conn::gpt-5-6-solm", { ok: false, testedAt: Date.now() }],
      ["provider-c-other::gpt-5-6-solm", { ok: true, testedAt: Date.now() }],
    ]);

    const result = await resolveAutoCombo("gpt-5.6-sol");

    expect(result.models[0]).toBe("prov-c/gpt-5-6-solm");
    expect(result.models.at(-1)).toBe("prov-a/gpt-5.6-sol");
    expect(result.members[0]).toMatchObject({ status: "working", source: "probe" });
    markAutoComboUnavailable("prov-c/gpt-5-6-solm", 503);
    expect((await resolveAutoCombo("gpt-5.6-sol")).members.find(({ providerId }) => providerId === "provider-c")).toMatchObject({ status: "not_working", source: "live" });
  });

  it("shares persisted probe and live status with configured combo members", async () => {
    state.probes.set("provider-a-conn::gpt-5.6-sol", { ok: true, testedAt: Date.now() });
    markAutoComboUnavailable("prov-b/gpt-5-6-sol", 503, "provider offline");

    const members = await inspectAutoComboMembers(["prov-a/gpt-5.6-sol", "prov-b/gpt-5-6-sol", "prov-c/gpt-5-6-solm"]);

    expect(members.map(({ status }) => status)).toEqual(["working", "not_working", "untested"]);
    expect(members[1].lastError).toBe("provider offline");
  });

  it("inspects only accounts advertising the configured member", async () => {
    state.connections = [
      conn("provider-a", { id: "matching", providerSpecificData: { enabledModels: ["claude-opus-5"] } }),
      conn("provider-a", { id: "other-model", providerSpecificData: { enabledModels: ["claude-sonnet-5"] } }),
    ];
    state.probes.set("matching::claude-opus-5", { ok: false, testedAt: Date.now() });

    expect((await inspectAutoComboMembers(["prov-a/claude-opus-5"]))[0].status).toBe("not_working");
  });

  it("reports model locks ahead of historical success without applying unrelated locks", async () => {
    state.connections = [conn("provider-a", {
      "modelLock_gpt-5.6-sol": new Date(Date.now() + 60000).toISOString(),
      "modelLock_claude-sonnet-5": new Date(Date.now() + 120000).toISOString(),
    })];
    state.probes.set("provider-a-conn::gpt-5.6-sol", { ok: true, testedAt: Date.now() });
    markAutoComboHealthy("prov-a/gpt-5.6-sol");

    expect((await inspectAutoComboMembers(["prov-a/gpt-5.6-sol"]))[0]).toMatchObject({ status: "not_working", source: "connection", disabled: true });
    expect((await resolveAutoCombo("gpt-5.6-sol")).models.at(-1)).toBe("prov-a/gpt-5.6-sol");
    delete state.connections[0]["modelLock_gpt-5.6-sol"];
    expect((await inspectAutoComboMembers(["prov-a/gpt-5.6-sol"]))[0].status).toBe("working");
  });

  it("reports inactive saved providers as unavailable while free providers need no account", async () => {
    state.connections = [];
    markAutoComboHealthy("prov-a/gpt-5.6-sol");
    markAutoComboHealthy("prov-free/gpt-5.6-sol");

    const members = await inspectAutoComboMembers(["prov-a/gpt-5.6-sol", "prov-free/gpt-5.6-sol"]);

    expect(members[0]).toMatchObject({ status: "not_working", source: "connection", lastError: "No active provider connections" });
    expect(members[1].status).toBe("working");
  });

  it("does not promote a different GPT version or model tier over the requested exact model", async () => {
    state.connections = [conn("provider-a", { providerSpecificData: { enabledModels: ["gpt-4o", "gpt-4", "gpt-4.1", "gpt-4.5"] } })];
    markAutoComboHealthy("prov-a/gpt-4");
    markAutoComboHealthy("prov-a/gpt-4.1");

    expect((await resolveAutoCombo("gpt-4o")).models).toEqual(["prov-a/gpt-4o"]);
  });

  it("shares the latest live outcome across aliases for the same provider", async () => {
    state.connections = [conn("claude", { providerSpecificData: { enabledModels: ["claude-opus-5"] } })];
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      markAutoComboUnavailable("cc/claude-opus-5", 503, "old error");
      clock.mockReturnValue(now + 1);
      markAutoComboHealthy("claude/claude-opus-5");

      expect((await inspectAutoComboMembers(["cc/claude-opus-5"]))[0]).toMatchObject({ status: "working", source: "live" });
    } finally {
      clock.mockRestore();
    }
  });

  it("uses a provider node name and keeps recorded error detail when all accounts are locked", async () => {
    state.connections = [conn("provider-a", {
      providerSpecificData: { prefix: "mygateway", nodeName: "My gateway", enabledModels: ["claude-opus-5"] },
      "modelLock_claude-opus-5": new Date(Date.now() + 60000).toISOString(),
    })];
    markAutoComboUnavailable("mygateway/claude-opus-5", 429, "monthly quota exhausted");

    const automatic = await resolveAutoCombo("claude-opus-5");
    const [configured] = await inspectAutoComboMembers(["mygateway/claude-opus-5"]);

    for (const member of [automatic.members[0], configured]) {
      expect(member).toMatchObject({ providerName: "My gateway", status: "not_working", lastStatus: 429, lastError: "monthly quota exhausted", lastFailureAt: expect.any(String) });
    }
  });
});
