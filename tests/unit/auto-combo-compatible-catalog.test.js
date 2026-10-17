import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ connections: [], disabled: {} }));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: async () => state.connections,
  getSettings: async () => ({}),
  getCombos: async () => [],
  getCustomModels: async () => [],
  getModelAliases: async () => ({}),
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => state.disabled }));
vi.mock("@/lib/modelProbe/routingHints", async (importOriginal) => ({
  ...await importOriginal(),
  getProbeHints: async () => new Map(),
}));

import { buildModelsList } from "@/app/api/v1/models/route.js";
import { resolveAutoCombo } from "@/sse/services/autoCombo";
import { invalidateUpstreamModels } from "@/lib/modelCatalog/upstreamCache";
import { resetAutoComboHealth } from "open-sse/services/autoComboHealth.js";

beforeEach(() => {
  invalidateUpstreamModels();
  resetAutoComboHealth();
  state.disabled = {};
  state.connections = [
    {
      id: "token-gateway", provider: "openai-compatible-chat-token-gateway", isActive: true,
      providerSpecificData: { prefix: "tkgt", enabledModels: ["kimi-k3"] },
    },
    {
      id: "justbash", provider: "openai-compatible-chat-justbash", isActive: true, apiKey: "test-key",
      providerSpecificData: { prefix: "jbash", baseUrl: "https://justbash.example/v1/" },
    },
  ];
});
afterEach(() => vi.unstubAllGlobals());

describe("automatic combos from compatible provider catalogs", () => {
  it("finds every Kimi K3 route published by /v1/models without refetching on the chat path", async () => {
    const fetch = vi.fn(async () => Response.json({ data: [
      { id: "kimi-k3" }, { id: "moonshotai/kimi-k3" }, { id: "kimi-k2.6" },
    ] }));
    vi.stubGlobal("fetch", fetch);

    const listed = await buildModelsList(["llm"]);
    expect(listed.map(({ id }) => id)).toEqual(expect.arrayContaining([
      "tkgt/kimi-k3", "jbash/kimi-k3", "jbash/moonshotai/kimi-k3",
    ]));
    expect(fetch).toHaveBeenCalledTimes(1);

    const combo = await resolveAutoCombo("kimi-k3");
    expect(combo.models).toEqual(expect.arrayContaining([
      "tkgt/kimi-k3", "jbash/kimi-k3", "jbash/moonshotai/kimi-k3",
    ]));
    expect(combo.models).not.toContain("jbash/kimi-k2.6");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps disabled dynamic models out of automatic combos", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "kimi-k3" }] })));
    await buildModelsList(["llm"]);
    state.disabled = { jbash: ["kimi-k3"] };
    const combo = await resolveAutoCombo("kimi-k3");
    expect(combo.models).toContain("tkgt/kimi-k3");
    expect(combo.models).not.toContain("jbash/kimi-k3");
  });

  it("does not turn a speech model from a mixed catalog into a chat fallback", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "kimi-k3", kind: "tts" }] })));
    await buildModelsList(["llm"]);
    const combo = await resolveAutoCombo("kimi-k3");
    expect(combo.models).not.toContain("jbash/kimi-k3");
  });
});
