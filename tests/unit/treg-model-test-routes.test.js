import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fx = vi.hoisted(() => ({
  getModelInfo: vi.fn(),
  getProviderCredentials: vi.fn(),
  getProviderConnectionById: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  pingModelByKind: vi.fn(),
}));

vi.mock("@/sse/services/model", () => ({ getModelInfo: fx.getModelInfo }));
vi.mock("@/sse/services/auth", () => ({ getProviderCredentials: fx.getProviderCredentials }));
vi.mock("@/lib/localDb", () => ({ getProviderConnectionById: fx.getProviderConnectionById }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: fx.resolveConnectionProxyConfig }));
vi.mock("@/app/api/models/test/ping", () => ({ pingModelByKind: fx.pingModelByKind }));
vi.mock("next/server", () => ({ NextResponse: { json: (body, init = {}) => Response.json(body, init) } }));

import { POST as testModel } from "@/app/api/models/test/route.js";
import { POST as testAllModels } from "@/app/api/providers/[id]/test-models/route.js";
import { getProviderModels } from "open-sse/config/providerModels.js";
import { TREG_CONFIG, TREG_ROUTES } from "open-sse/config/treg.js";

const connection = {
  id: "selected-treg-key", provider: "treg", authType: "apikey",
  apiKey: "selected-treg-token", providerSpecificData: { org: "test-org" },
};
const cases = [
  ["image", "replicate.image-gen.flux-schnell", "image-gen"],
  ["video", "minimax.video-gen.h3.generate", "video-gen"],
  ["tts", "fishaudio.tts.s2-1-pro", "voice-gen"],
];
const platforms = Object.fromEntries(cases.map(([kind, , platform]) => [kind, platform]));

function request(body) {
  return new Request("https://9router.local/api/models/test", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

function metadataFetch(url, init) {
  if (init?.method !== "GET") throw new Error("Model checks must not submit work");
  if (url === TREG_CONFIG.validateUrl) return Response.json({ user: { id: "test-user" } });
  const prefix = `${TREG_CONFIG.baseUrl}/catalog/endpoints/`;
  if (String(url).startsWith(prefix)) {
    const model = decodeURIComponent(String(url).slice(prefix.length));
    return Response.json({ endpoint: { id: model, kind: "data", platform: platforms[TREG_ROUTES[model]?.kind] } });
  }
  throw new Error(`Unexpected model check endpoint: ${url}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  fx.getModelInfo.mockImplementation(async (model) => ({ provider: "treg", model: model.slice("treg/".length) }));
  fx.getProviderCredentials.mockResolvedValue({ connectionId: connection.id });
  fx.getProviderConnectionById.mockResolvedValue(connection);
  fx.resolveConnectionProxyConfig.mockResolvedValue({});
  fx.pingModelByKind.mockResolvedValue({ ok: true, error: null, status: 200 });
  vi.stubGlobal("fetch", vi.fn(async (url, init) => metadataFetch(url, init)));
});

afterEach(() => vi.unstubAllGlobals());

describe("dashboard Treg single-model tests", () => {
  it.each(cases)("checks %s against the selected key using nonbillable GETs", async (kind, model) => {
    const req = request({ model: `treg/${model}`, kind });
    const response = await testModel(req);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true, error: null, status: 200,
      note: "Token and catalog endpoint verified; generation was not run",
    });
    expect(fx.getProviderCredentials).toHaveBeenCalledWith("treg", new Set(), model);
    expect(fx.getProviderConnectionById).toHaveBeenCalledExactlyOnceWith(connection.id);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      TREG_CONFIG.validateUrl, `${TREG_CONFIG.baseUrl}/catalog/endpoints/${model}`,
    ]);
    expect(new Headers(fetch.mock.calls[0][1].headers).get("x-treg-token")).toBe(connection.apiKey);
    expect(new Headers(fetch.mock.calls[0][1].headers).get("x-treg-org")).toBe("test-org");
    expect(new Headers(fetch.mock.calls[1][1].headers).get("x-treg-token")).toBeNull();
    expect(fx.pingModelByKind).not.toHaveBeenCalled();
  });

  it("rejects a mismatched kind without generating an image or testing chat", async () => {
    const response = await testModel(request({ model: `treg/${cases[0][1]}`, kind: "video" }));

    expect(await response.json()).toMatchObject({ ok: false, status: 400 });
    expect(fetch).not.toHaveBeenCalled();
    expect(fx.pingModelByKind).not.toHaveBeenCalled();
  });

  it("rejects a Treg request with no kind instead of treating it as chat", async () => {
    const response = await testModel(request({ model: `treg/${cases[0][1]}` }));

    expect(await response.json()).toMatchObject({ ok: false, status: 400 });
    expect(fetch).not.toHaveBeenCalled();
    expect(fx.pingModelByKind).not.toHaveBeenCalled();
  });

  it("returns token failure without rotating keys or falling back to generation", async () => {
    fetch.mockResolvedValueOnce(Response.json({ detail: "bad token" }, { status: 401 }));
    const response = await testModel(request({ model: `treg/${cases[0][1]}`, kind: "image" }));

    expect(await response.json()).toMatchObject({ ok: false, status: 401, error: "Invalid Treg API token" });
    expect(fx.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fx.pingModelByKind).not.toHaveBeenCalled();
  });

  it("reports missing credentials without a generic model test", async () => {
    fx.getProviderCredentials.mockResolvedValueOnce(null);
    const response = await testModel(request({ model: `treg/${cases[1][1]}`, kind: "video" }));

    expect(await response.json()).toMatchObject({ ok: false, status: 404, error: "No active credentials for provider: treg" });
    expect(fetch).not.toHaveBeenCalled();
    expect(fx.pingModelByKind).not.toHaveBeenCalled();
  });

  it("preserves the internal image test for other providers", async () => {
    fx.getModelInfo.mockResolvedValueOnce({ provider: "huggingface", model: "flux-schnell" });

    expect(await (await testModel(request({ model: "hf/flux-schnell", kind: "image" }))).json()).toMatchObject({ ok: true });
    expect(fx.pingModelByKind).toHaveBeenCalledWith("hf/flux-schnell", "image");
    expect(fx.getProviderCredentials).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("dashboard Treg test-all route", () => {
  it("checks every image, video, and speech endpoint with the specified connection", async () => {
    const req = new Request(`https://9router.local/api/providers/${connection.id}/test-models`, { method: "POST" });
    const response = await testAllModels(req, { params: Promise.resolve({ id: connection.id }) });
    const body = await response.json();
    const models = getProviderModels("treg");

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ provider: "treg", connectionId: connection.id });
    expect(body.results.map((result) => result.modelId)).toEqual(models.map((model) => model.id));
    expect(body.results.every((result) => result.ok && result.note.includes("generation was not run"))).toBe(true);
    expect(new Set(models.map((model) => model.kind))).toEqual(new Set(["image", "video", "tts"]));
    expect(fetch).toHaveBeenCalledTimes(models.length * 2);
    for (const [url, init] of fetch.mock.calls) {
      expect(init.method).toBe("GET");
      expect(init.body).toBeUndefined();
      if (url === TREG_CONFIG.validateUrl) {
        expect(new Headers(init.headers).get("x-treg-token")).toBe(connection.apiKey);
      } else {
        expect(url).toMatch(/^https:\/\/treg\.to\/catalog\/endpoints\//);
        expect(new Headers(init.headers).get("x-treg-token")).toBeNull();
      }
    }
    expect(fx.getProviderConnectionById).toHaveBeenCalledExactlyOnceWith(connection.id);
    expect(fx.getProviderCredentials).not.toHaveBeenCalled();
    expect(fx.pingModelByKind).not.toHaveBeenCalled();
  });
});
