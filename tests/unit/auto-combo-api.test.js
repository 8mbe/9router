import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  settings: {},
  aliases: {},
  combos: {},
  health: [],
  resolve: vi.fn(),
  inspect: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => state.settings,
  getModelAliases: async () => state.aliases,
  getCombos: async () => Object.entries(state.combos).map(([name, models]) => ({ name, models })),
}));
vi.mock("@/sse/services/model", () => ({
  getComboModels: async (name) => state.combos[name] || null,
}));
vi.mock("@/sse/services/autoCombo", () => ({
  resolveAutoCombo: state.resolve,
  inspectAutoComboMembers: state.inspect,
}));
vi.mock("open-sse/services/autoComboHealth.js", () => ({
  getAutoComboHealth: () => state.health,
  resetAutoComboHealth: state.reset,
}));

const { GET, DELETE } = await import("@/app/api/auto-combo/route.js");
const request = (model) => new Request(`http://localhost/api/auto-combo${model ? `?model=${encodeURIComponent(model)}` : ""}`);

beforeEach(() => {
  vi.clearAllMocks();
  state.settings = {};
  state.aliases = {};
  state.combos = {};
  state.health = [];
  state.resolve.mockResolvedValue(null);
  state.inspect.mockImplementation(async (models) => models.map((member) => ({ member, status: "untested" })));
});

describe("combo status API", () => {
  it("returns the complete automatic order and recorded statuses without caching", async () => {
    const resolved = {
      models: ["good/claude-opus-5", "bad/claude-opus-4"],
      benched: ["bad/claude-opus-4"],
      matchTier: 0,
      members: [
        { member: "good/claude-opus-5", status: "working" },
        { member: "bad/claude-opus-4", status: "not_working", lastStatus: 403 },
      ],
    };
    state.resolve.mockResolvedValue(resolved);
    const response = await GET(request(" claude-opus-5[1m] "));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ model: "claude-opus-5", source: "automatic", resolved, enabled: true, strategy: "fallback" });
    expect(state.resolve).toHaveBeenCalledWith("claude-opus-5", state.settings);
  });

  it("inspects a saved combo before an alias or automatic family, including its strategy", async () => {
    state.combos.writing = ["cc/claude-opus-5", "cu/claude-4.6-opus"];
    state.aliases.writing = "other/model";
    state.settings = { autoComboEnabled: false, comboStrategies: { writing: { fallbackStrategy: "round-robin" } } };
    const data = await (await GET(request("writing"))).json();
    expect(data).toMatchObject({ source: "combo", enabled: false, strategy: "round-robin", resolved: { models: state.combos.writing } });
    expect(state.inspect).toHaveBeenCalledWith(state.combos.writing, state.settings);
    expect(state.resolve).not.toHaveBeenCalled();
  });

  it.each(["cc/claude-opus-5", { provider: "cc", model: "claude-opus-5" }])("inspects explicit alias %j", async (alias) => {
    state.aliases.writing = alias;
    const data = await (await GET(request("writing"))).json();
    expect(data).toMatchObject({ source: "alias", resolved: { models: ["cc/claude-opus-5"] } });
    expect(state.resolve).not.toHaveBeenCalled();
  });

  it("keeps nested combo names separate from concrete provider health", async () => {
    state.combos = { outer: ["inner"], inner: ["cc/claude-opus-5"] };
    const data = await (await GET(request("outer"))).json();
    expect(data.resolved.members).toEqual([{ member: "inner", modelId: "inner", providerId: null, status: "untested" }]);
    expect(data.health.map((entry) => entry.member)).toEqual(["cc/claude-opus-5"]);
  });

  it("reports disabled automatic routing distinctly from a successful match", async () => {
    state.settings.autoComboEnabled = false;
    expect(await (await GET(request("claude-opus-5"))).json()).toMatchObject({ enabled: false, source: null, resolved: null });
  });

  it("provides health without model resolution for configured combo and adapter rows", async () => {
    state.health = [{ member: "cc/claude-opus-5", status: "working" }];
    expect(await (await GET(request())).json()).toMatchObject({ health: state.health, enabled: true });
    expect(state.resolve).not.toHaveBeenCalled();
  });

  it("does not expose internal errors in a failed dashboard read", async () => {
    state.resolve.mockRejectedValueOnce(new Error("internal connection details"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await GET(request("claude-opus-5"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to read combo status" });
    log.mockRestore();
  });

  it("clears only the requested member", async () => {
    const response = await DELETE(new Request("http://localhost/api/auto-combo?member=cc%2Fclaude-opus-5", { method: "DELETE" }));
    expect(response.status).toBe(200);
    expect(state.reset).toHaveBeenCalledWith("cc/claude-opus-5");
  });
});
