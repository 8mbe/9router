import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  extractApiKey: vi.fn(),
  isValidApiKey: vi.fn(),
}));
const tokens = vi.hoisted(() => ({ checkAndRefreshToken: vi.fn(), updateProviderCredentials: vi.fn() }));
const db = vi.hoisted(() => ({ getSettings: vi.fn(), getProviderConnectionById: vi.fn() }));
const access = vi.hoisted(() => ({ getKeyAccessContext: vi.fn(), enforceKeyAccessResolved: vi.fn() }));

vi.mock("@/sse/services/auth.js", () => auth);
vi.mock("@/sse/services/tokenRefresh.js", () => tokens);
vi.mock("@/lib/localDb", () => ({
  ...db,
  getComboByName: vi.fn(async () => null),
  getModelAliases: vi.fn(async () => ({})),
  getProviderNodes: vi.fn(async () => []),
}));
vi.mock("@/sse/services/keyAccess.js", () => access);
vi.mock("@/sse/utils/logger.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

import { handleVideoCreate, handleVideoGet } from "@/sse/handlers/videoGeneration.js";

const MODEL = "minimax.video-gen.h3.generate";
const CONNECTION_ID = "treg-owner-connection";
const TASK_ID = "upstream-task-123";
const VIDEO_URL = "https://cdn.example.com/generated.mp4";
const CREDENTIALS = {
  connectionId: CONNECTION_ID, authType: "apikey", apiKey: "owner-treg-token",
  providerSpecificData: { org: "owner-team" },
};

const jobId = (values = [MODEL, TASK_ID, CONNECTION_ID]) =>
  `treg_${Buffer.from(JSON.stringify(values)).toString("base64url")}`;
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
const createRequest = (headers = {}) => new Request("http://localhost/v1/videos/generations", {
  method: "POST", headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify({ model: `treg/${MODEL}`, prompt: "A paper boat floats across a pond." }),
});
const pollRequest = (id = jobId(), headers = {}, query = "") =>
  new Request(`http://localhost/v1/videos/${id}${query}`, { headers });

beforeEach(() => {
  vi.clearAllMocks();
  auth.getProviderCredentials.mockReset().mockResolvedValue({ ...CREDENTIALS });
  auth.markAccountUnavailable.mockResolvedValue({ shouldFallback: true, cooldownMs: 0 });
  auth.clearAccountError.mockResolvedValue(undefined);
  auth.extractApiKey.mockReturnValue(null);
  auth.isValidApiKey.mockResolvedValue(true);
  tokens.checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
  tokens.updateProviderCredentials.mockResolvedValue(undefined);
  db.getSettings.mockResolvedValue({ requireApiKey: false });
  db.getProviderConnectionById.mockResolvedValue({ id: CONNECTION_ID, provider: "treg" });
  access.getKeyAccessContext.mockResolvedValue({ apiKey: "client-key" });
  access.enforceKeyAccessResolved.mockReset().mockResolvedValue(null);
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => vi.unstubAllGlobals());

describe("Treg app video creation", () => {
  it("encodes the serving connection in the production job id", async () => {
    fetch.mockResolvedValueOnce(json({ task_id: TASK_ID }));
    const response = await handleVideoCreate(createRequest({ "idempotency-key": "client-job-key" }), "generations");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-9router-connection-id")).toBe(CONNECTION_ID);
    expect(body).toMatchObject({ request_id: body.id, status: "pending", poll_after_seconds: 30 });
    expect(JSON.parse(Buffer.from(body.id.slice(5), "base64url").toString()))
      .toEqual([MODEL, TASK_ID, CONNECTION_ID]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(`https://treg.to/call/${MODEL}`);
    expect(fetch.mock.calls[0][1]).toMatchObject({
      method: "POST", redirect: "error",
      headers: { "X-Treg-Token": CREDENTIALS.apiKey, "X-Treg-Org": "owner-team", "Idempotency-Key": "client-job-key" },
    });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
      model: "MiniMax-H3-Max", content: [{ type: "text", text: "A paper boat floats across a pond." }],
    });
  });

  it("returns uncertain creation failures without submitting on another account", async () => {
    fetch.mockResolvedValueOnce(json({ detail: "Submission interrupted" }, 502));
    const response = await handleVideoCreate(createRequest(), "generations");
    expect(response.status).toBe(502);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(auth.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(auth.markAccountUnavailable).toHaveBeenCalledWith(CONNECTION_ID, 502, expect.any(String), "treg", MODEL);
  });
});

describe("Treg app video polling", () => {
  it("infers Treg and pins the encoded owner without an explicit connection header", async () => {
    fetch.mockResolvedValueOnce(json({ task: { status: "succeeded", content: { url: VIDEO_URL } } }));
    const id = jobId();
    const response = await handleVideoGet(pollRequest(id, {}, "?provider=xai"), id);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id, request_id: id, status: "completed", video: { url: VIDEO_URL } });
    expect(response.headers.get("x-9router-connection-id")).toBe(CONNECTION_ID);
    expect(auth.getProviderCredentials).toHaveBeenCalledExactlyOnceWith(
      "treg", null, null, { preferredConnectionId: CONNECTION_ID },
    );
    expect(access.enforceKeyAccessResolved).toHaveBeenCalledWith(
      { apiKey: "client-key" }, `treg/${MODEL}`, "treg", MODEL,
    );
    expect(db.getProviderConnectionById).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(`https://treg.to/call/minimax.video-gen.v2.task.status?task_id=${TASK_ID}`);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "GET", headers: { "X-Treg-Token": CREDENTIALS.apiKey } });
  });

  it("rejects another account returned when the owner is unavailable", async () => {
    auth.getProviderCredentials.mockResolvedValueOnce({ ...CREDENTIALS, connectionId: "other-connection", apiKey: "other-token" });
    const response = await handleVideoGet(pollRequest(), jobId());
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("connection that created this Treg video job is unavailable");
    expect(auth.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(tokens.checkAndRefreshToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not rotate when no owner credentials can be selected", async () => {
    auth.getProviderCredentials.mockResolvedValueOnce(null);
    const response = await handleVideoGet(pollRequest(), jobId());
    expect(response.status).toBe(400);
    expect(auth.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a conflicting connection header before selecting credentials", async () => {
    const response = await handleVideoGet(pollRequest(jobId(), { "x-connection-id": "other-connection" }), jobId());
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("belongs to a different connection");
    expect(auth.getProviderCredentials).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts an explicit connection header matching the owner", async () => {
    fetch.mockResolvedValueOnce(json({ task: { status: "processing" } }));
    const response = await handleVideoGet(pollRequest(jobId(), { "x-connection-id": CONNECTION_ID }), jobId());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "pending", poll_after_seconds: 30 });
    expect(auth.getProviderCredentials).toHaveBeenCalledExactlyOnceWith("treg", null, null, { preferredConnectionId: CONNECTION_ID });
  });

  it("enforces restricted client keys before credentials or upstream polling", async () => {
    const context = { apiKey: "restricted-key", allowedModels: ["xai/grok-imagine-video"] };
    access.getKeyAccessContext.mockResolvedValueOnce(context);
    access.enforceKeyAccessResolved.mockResolvedValueOnce(json({ error: { message: "Model access denied" } }, 403));
    const response = await handleVideoGet(pollRequest(), jobId());
    expect(response.status).toBe(403);
    expect(access.enforceKeyAccessResolved).toHaveBeenCalledWith(context, `treg/${MODEL}`, "treg", MODEL);
    expect(auth.getProviderCredentials).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "treg_invalid",
    "treg_%",
    jobId(["unknown-route", TASK_ID, CONNECTION_ID]),
    jobId([MODEL, TASK_ID, 42]),
    jobId([MODEL, "", CONNECTION_ID]),
  ])("rejects malformed job id %s without calling an upstream", async (id) => {
    const response = await handleVideoGet(pollRequest(id), id);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Invalid Treg video job id");
    expect(auth.getProviderCredentials).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
