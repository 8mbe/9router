import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  extractApiKey: vi.fn(),
  isValidApiKey: vi.fn(),
}));
const tokens = vi.hoisted(() => ({ checkAndRefreshToken: vi.fn(), updateProviderCredentials: vi.fn() }));
const db = vi.hoisted(() => ({ getSettings: vi.fn(), getComboByName: vi.fn() }));

vi.mock("@/sse/services/auth.js", () => auth);
vi.mock("@/sse/services/tokenRefresh.js", () => tokens);
vi.mock("@/lib/localDb", () => ({
  ...db,
  getModelAliases: vi.fn(async () => ({})),
  getProviderNodes: vi.fn(async () => []),
}));
vi.mock("@/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: vi.fn(async () => null),
  enforceKeyAccess: vi.fn(async () => null),
}));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn(async () => {}) }));
vi.mock("@/sse/utils/logger.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

import { handleImageGeneration } from "@/sse/handlers/imageGeneration.js";

const MODEL = "replicate.image-gen.flux-schnell";
const SECOND_MODEL = "minimax.image-gen.from_text";
const CREDENTIALS = { connectionId: "treg-image-owner", authType: "apikey", apiKey: "image-owner-token" };
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
const request = (model = `treg/${MODEL}`, extras = {}) => new Request("http://localhost/v1/images/generations", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model, prompt: "A paper boat floats across a pond.", ...extras }),
});

beforeEach(() => {
  vi.clearAllMocks();
  auth.getProviderCredentials.mockReset().mockResolvedValue({ ...CREDENTIALS });
  auth.markAccountUnavailable.mockResolvedValue({ shouldFallback: true, cooldownMs: 0 });
  auth.clearAccountError.mockResolvedValue(undefined);
  auth.extractApiKey.mockReturnValue(null);
  auth.isValidApiKey.mockResolvedValue(true);
  tokens.checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
  tokens.updateProviderCredentials.mockResolvedValue(undefined);
  db.getSettings.mockResolvedValue({ requireApiKey: false, comboStrategy: "fallback" });
  db.getComboByName.mockReset().mockResolvedValue(null);
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => vi.unstubAllGlobals());

describe("Treg app image retry behavior", () => {
  it.each([502, 503, 504])("does not rotate accounts after uncertain HTTP %s submission failures", async (status) => {
    fetch.mockResolvedValueOnce(json({ detail: "Submission interrupted" }, status));
    const response = await handleImageGeneration(request());
    expect(response.status).toBe(status);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(auth.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(auth.markAccountUnavailable).toHaveBeenCalledWith(CREDENTIALS.connectionId, status, expect.any(String), "treg", MODEL);
  });

  it("does not rotate accounts after a network failure that may have created a task", async () => {
    fetch.mockRejectedValueOnce(new TypeError("Connection reset"));
    const response = await handleImageGeneration(request());
    expect(response.status).toBe(502);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(await response.text()).toContain("Connection reset");
    expect(auth.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not resubmit when a successful submission cannot be normalized", async () => {
    fetch.mockResolvedValueOnce(json({ status: "starting" }));
    const response = await handleImageGeneration(request());
    expect(response.status).toBe(502);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(await response.text()).toContain("returned no task id");
    expect(auth.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["upstream error", "network failure"])("stops combo fallback after uncertain %s", async (failure) => {
    db.getComboByName.mockResolvedValueOnce({
      name: "image-combo", models: [`treg/${MODEL}`, `treg/${SECOND_MODEL}`],
    });
    if (failure === "network failure") fetch.mockRejectedValueOnce(new TypeError("Connection reset"));
    else fetch.mockResolvedValueOnce(json({ detail: "Submission interrupted" }, 502));
    const response = await handleImageGeneration(request("image-combo"));

    expect(response.status).toBe(502);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(auth.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(`https://treg.to/call/${MODEL}`);
  });

  it("can rotate accounts after a pre-submission rate-limit rejection", async () => {
    auth.getProviderCredentials
      .mockResolvedValueOnce({ ...CREDENTIALS })
      .mockResolvedValueOnce({ ...CREDENTIALS, connectionId: "second-image-account", apiKey: "second-image-token" });
    fetch.mockResolvedValueOnce(json({ detail: "Rate limited before submission" }, 429))
      .mockResolvedValueOnce(json({ id: "accepted-task", status: "succeeded", output: ["https://cdn.example.com/image.webp"] }));
    const response = await handleImageGeneration(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: [{ url: "https://cdn.example.com/image.webp" }] });
    expect(auth.getProviderCredentials).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1].headers["X-Treg-Token"]).toBe("second-image-token");
  });

  it("rejects unsupported native options before creating a billable task", async () => {
    const response = await handleImageGeneration(request(undefined, { provider_options: { unknown_field: true } }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Unsupported Treg provider option");
    expect(auth.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});
