import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleImageGenerationCore } from "open-sse/handlers/imageGenerationCore.js";
import { handleVideoProxyCore } from "open-sse/handlers/videoCore.js";
import { TREG_CONFIG, TREG_ROUTES } from "open-sse/config/treg.js";
import { PROVIDER_MEDIA, PROVIDER_MODELS, PROVIDERS } from "open-sse/providers/index.js";
import { getProvidersByKind } from "@/shared/constants/providers";
import { encodeTregJob, decodeTregJob } from "open-sse/handlers/treg/generation.js";

const credentials = { apiKey: "treg-test-token", providerSpecificData: { org: "studio" } };
const imageModel = "replicate.image-gen.flux-schnell";
const videoModel = "minimax.video-gen.h3.generate";
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...extra } });
const originalFetch = global.fetch;

beforeEach(() => { global.fetch = vi.fn(); });
afterEach(() => { global.fetch = originalFetch; vi.useRealTimers(); });

function image(model = imageModel, body = {}) {
  return handleImageGenerationCore({ modelInfo: { provider: "treg", model }, body: { prompt: "A paper boat", ...body }, credentials });
}
function video(model = videoModel, body = {}, options = {}) {
  return handleVideoProxyCore({ provider: "treg", action: "generations", contentType: "application/json", rawBody: JSON.stringify({ model, prompt: "A paper boat", ...body }), credentials, ...options });
}

describe("Treg registration", () => {
  it("appears in all five supported categories and only registers media models", () => {
    for (const kind of ["image", "video", "tts", "webSearch", "webFetch"]) {
      expect(getProvidersByKind(kind).some((provider) => provider.id === "treg")).toBe(true);
      expect(PROVIDER_MEDIA.treg.serviceKinds).toContain(kind);
    }
    expect(getProvidersByKind("llm").some((provider) => provider.id === "treg")).toBe(false);
    expect(PROVIDERS.treg).toBeUndefined();
    expect(PROVIDER_MODELS.treg).toHaveLength(Object.keys(TREG_ROUTES).length);
    expect(new Set(PROVIDER_MODELS.treg.map((model) => model.kind))).toEqual(new Set(["image", "video", "tts"]));
  });
});

describe("Treg images", () => {
  it("maps Replicate parameters, normalizes completed images, and retains call metadata", async () => {
    global.fetch.mockResolvedValueOnce(json({ id: "prediction-1", status: "succeeded", output: ["https://cdn.example/image.webp"] }, 200, { "X-Treg-Call-Id": "call-1", "X-Treg-Cost-Micro": "3000" }));
    const result = await image(imageModel, { n: 2, size: "1792x1024" });
    expect(result.success).toBe(true);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe("https://treg.to/call/replicate.image-gen.flux-schnell");
    expect(init.headers["X-Treg-Token"]).toBe(credentials.apiKey);
    expect(init.headers["X-Treg-Org"]).toBe("studio");
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({ input: { prompt: "A paper boat", num_outputs: 2, aspect_ratio: "16:9", output_format: "webp" } });
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((await result.response.json()).data).toEqual([{ url: "https://cdn.example/image.webp" }]);
    expect(result.response.headers.get("X-Treg-Cost-Micro")).toBe("3000");
  });

  it("polls the catalog task endpoint without submitting another image", async () => {
    vi.useFakeTimers();
    global.fetch
      .mockResolvedValueOnce(json({ id: "task/a", status: "starting" }))
      .mockResolvedValueOnce(json({ id: "task/a", status: "processing" }))
      .mockResolvedValueOnce(json({ id: "task/a", status: "succeeded", output: "https://cdn.example/image.webp" }));
    const promise = image();
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.success).toBe(true);
    expect(global.fetch.mock.calls[1][0]).toBe("https://treg.to/call/replicate.predictions.get?id=task%2Fa");
    expect(global.fetch.mock.calls[1][1].method).toBeUndefined();
    expect(global.fetch.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
  });

  it("fails a moderated task and preserves the upstream HTTP status on submission failure", async () => {
    global.fetch.mockResolvedValueOnce(json({ id: "p1", status: "failed", error: "moderated" }));
    expect((await image()).success).toBe(false);
    global.fetch.mockResolvedValueOnce(json({ detail: "Insufficient balance" }, 402));
    const result = await image();
    expect(result.status).toBe(402);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("handles synchronous MiniMax URL and base64 responses", async () => {
    global.fetch.mockResolvedValueOnce(json({ base_resp: { status_code: 0 }, data: { image_urls: ["https://cdn.example/mm.png"] } }));
    const result = await image("minimax.image-gen.from_text", { size: "1024x1536" });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toMatchObject({ model: "image-01", prompt: "A paper boat", aspect_ratio: "2:3" });
    expect((await result.response.json()).data).toEqual([{ url: "https://cdn.example/mm.png" }]);
    global.fetch.mockResolvedValueOnce(json({ data: { image_base64: ["AAAB"] } }));
    expect((await (await image("minimax.image-gen.from_text", { response_format: "b64_json" })).response.json()).data).toEqual([{ b64_json: "AAAB" }]);
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).response_format).toBe("base64");
  });

  it("handles native Gemini query parameters and inline image data", async () => {
    global.fetch.mockResolvedValueOnce(json({ candidates: [{ content: { parts: [{ text: "Here it is" }, { inlineData: { mimeType: "image/png", data: "AAAB" } }] } }] }));
    const result = await image("google-ai.image-gen.gemini-3-1-flash-image", { size: "1024x1024", resolution: "2K" });
    expect(global.fetch.mock.calls[0][0]).toBe("https://treg.to/call/google-ai.image-gen.gemini-3-1-flash-image?model=gemini-3.1-flash-image");
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toMatchObject({ contents: [{ parts: [{ text: "A paper boat" }] }], generationConfig: { imageConfig: { aspectRatio: "1:1", imageSize: "2K" } } });
    expect((await result.response.json()).data).toEqual([{ b64_json: "AAAB" }]);
  });

  it("sends source images as native Gemini inlineData", async () => {
    global.fetch.mockResolvedValueOnce(json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "AAAB" } }] } }] }));
    await image("google-ai.image-gen.gemini-3-1-flash-image", { image: "data:image/png;base64,AAAA" });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).contents[0].parts).toEqual([{ text: "A paper boat" }, { inlineData: { mimeType: "image/png", data: "AAAA" } }]);
  });

  it("supports image-to-image native parameter mappings", async () => {
    global.fetch.mockResolvedValueOnce(json({ id: "p1", status: "succeeded", output: "https://cdn.example/out.png" }));
    await image("replicate.image-gen.nano-banana-pro", { image: "https://cdn.example/in.png" });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).input.image_input).toEqual(["https://cdn.example/in.png"]);
  });

  it("preserves native Gemini aspect ratios unless an OpenAI size overrides them", async () => {
    const response = { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "AAAB" } }] } }] };
    global.fetch.mockResolvedValueOnce(json(response));
    await image("google-ai.image-gen.gemini-3-pro-image", { size: "auto", provider_options: { generationConfig: { imageConfig: { aspectRatio: "9:16" } } } });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).generationConfig.imageConfig).toMatchObject({ aspectRatio: "9:16", imageSize: "1K" });
  });

  it("maps PiAPI inline outputs and reAPI image URLs", async () => {
    global.fetch.mockResolvedValueOnce(json({ task_id: "p1", data: { status: "completed", output: { data: [{ b64_json: "AAAB" }] } } }));
    expect((await (await image("piapi.image-gen.gpt-image-2")).response.json()).data).toEqual([{ b64_json: "AAAB" }]);
    global.fetch.mockResolvedValueOnce(json({ id: "r1", status: "completed", output: { image_urls: ["https://cdn.example/r.png"] } }));
    const result = await image("reapi.image-gen.gpt-image-2", { size: "1536x1024" });
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).size).toBe("3:2");
    expect((await result.response.json()).data).toEqual([{ url: "https://cdn.example/r.png" }]);
  });

  it("rejects unknown models, unsupported counts, missing source images and invalid dimensions before billing", async () => {
    for (const [model, body] of [["unknown", {}], [imageModel, { n: 0 }], [imageModel, { size: "bad" }], ["google-ai.image-gen.gemini-3-1-flash-image", { n: 2 }]]) {
      expect((await image(model, body)).status).toBe(400);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("does not retry after a network error or successful response without media", async () => {
    global.fetch.mockRejectedValueOnce(new Error("socket closed"));
    const failed = await image();
    expect(failed.success).toBe(false);
    expect(failed.response.headers.get("x-should-retry")).toBe("false");
    global.fetch.mockResolvedValueOnce(json({ id: "p1", status: "succeeded", output: [] }));
    expect((await image()).success).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("redacts credentials reflected in upstream submission errors", async () => {
    global.fetch.mockResolvedValueOnce(json({ error: { message: `Rejected token ${credentials.apiKey}` } }, 500));
    const result = await image();
    expect(result.error).not.toContain(credentials.apiKey);
    expect(result.error).toContain("[redacted]");
    expect(result.response.headers.get("x-should-retry")).toBe("false");
  });
});

describe("Treg videos", () => {
  it("creates a H3 task and returns a route-bearing resumable id", async () => {
    global.fetch.mockResolvedValueOnce(json({ task_id: "h3-task", base_resp: { status_code: 0 } }));
    const result = await video(videoModel, { duration: 8, aspect_ratio: "9:16", resolution: "768P" }, { idempotencyKey: "request-1", credentials: { ...credentials, connectionId: "connection-1" } });
    expect(result.success).toBe(true);
    expect(global.fetch.mock.calls[0][0]).toBe("https://treg.to/call/minimax.video-gen.h3.generate");
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ model: "MiniMax-H3-Max", content: [{ type: "text", text: "A paper boat" }], resolution: "768P", duration: 8, ratio: "9:16" });
    expect(global.fetch.mock.calls[0][1].headers["Idempotency-Key"]).toBe("request-1");
    const body = await result.response.json();
    expect(body.status).toBe("pending");
    expect(body.poll_after_seconds).toBe(30);
    expect(decodeTregJob(body.request_id)).toMatchObject({ model: videoModel, taskId: "h3-task", connectionId: "connection-1" });
    expect(global.fetch.mock.calls[0][1].redirect).toBe("error");
  });

  it("polls H3 and maps completed video URLs", async () => {
    const requestId = encodeTregJob(videoModel, "h3/task");
    global.fetch.mockResolvedValueOnce(json({ task: { status: "succeeded", content: { url: "https://cdn.example/h3.mp4" } } }));
    const result = await handleVideoProxyCore({ provider: "treg", requestId, credentials });
    expect(global.fetch.mock.calls[0][0]).toBe("https://treg.to/call/minimax.video-gen.v2.task.status?task_id=h3%2Ftask");
    expect(await result.response.json()).toMatchObject({ request_id: requestId, status: "completed", video: { url: "https://cdn.example/h3.mp4" } });
  });

  it("retrieves Hailuo files after the terminal status", async () => {
    const requestId = encodeTregJob("minimax.video-gen.from_text", "hailuo-task");
    global.fetch.mockResolvedValueOnce(json({ status: "Success", file_id: "file/1" })).mockResolvedValueOnce(json({ file: { download_url: "https://cdn.example/hailuo.mp4" } }));
    const result = await handleVideoProxyCore({ provider: "treg", requestId, credentials });
    expect(global.fetch.mock.calls[1][0]).toBe("https://treg.to/call/minimax.video-gen.result.retrieve?file_id=file%2F1");
    expect(global.fetch.mock.calls[1][1].headers["X-Treg-Token"]).toBe(credentials.apiKey);
    expect((await result.response.json()).video.url).toBe("https://cdn.example/hailuo.mp4");
  });

  it("supports Hailuo image-to-video and Replicate video native bodies", async () => {
    global.fetch.mockResolvedValueOnce(json({ task_id: "h-task" })).mockResolvedValueOnce(json({ id: "r-task", status: "starting" }));
    await video("minimax.video-gen.from_image", { image: "https://cdn.example/frame.png" });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).first_frame_image).toBe("https://cdn.example/frame.png");
    await video("replicate.video-gen.veo-3.1-fast", { image: "https://cdn.example/frame.png", duration: 6 });
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).input).toMatchObject({ prompt: "A paper boat", duration: 6, aspect_ratio: "16:9", image: "https://cdn.example/frame.png" });
  });

  it("maps both generic and native ratios onto reAPI size", async () => {
    global.fetch.mockResolvedValueOnce(json({ id: "r1", status: "pending" })).mockResolvedValueOnce(json({ id: "r2", status: "pending" }));
    await video("reapi.video-gen.seedance-2-5", { aspect_ratio: "9:16" });
    await video("reapi.video-gen.seedance-2-5", { size: "4:3" });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).size).toBe("9:16");
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).size).toBe("4:3");
  });

  it("keeps failed tasks as failed and refuses semantic provider errors", async () => {
    global.fetch.mockResolvedValueOnce(json({ task: { status: "failed" } }));
    const result = await handleVideoProxyCore({ provider: "treg", requestId: encodeTregJob(videoModel, "failed"), credentials });
    expect((await result.response.json()).status).toBe("failed");
    global.fetch.mockResolvedValueOnce(json({ base_resp: { status_code: 1004, status_msg: "Unauthorized" } }));
    expect((await video()).success).toBe(false);
  });

  it("returns an error when final file retrieval fails instead of passing through a misleading success", async () => {
    global.fetch.mockResolvedValueOnce(json({ status: "Success", file_id: "file-1" })).mockResolvedValueOnce(json({ detail: "File expired" }, 404));
    const result = await handleVideoProxyCore({ provider: "treg", requestId: encodeTregJob("minimax.video-gen.from_text", "task"), credentials });
    expect(result.success).toBe(false);
    expect(result.status).toBe(404);
  });

  it("rejects invalid models, forged job routes, multipart and unsupported actions before fetch", async () => {
    const forged = `treg_${Buffer.from(JSON.stringify(["https://attacker.example", "task"])).toString("base64url")}`;
    for (const requestId of [forged, "treg_!!!", encodeTregJob(imageModel, "task"), "treg_e30"]) {
      expect((await handleVideoProxyCore({ provider: "treg", requestId, credentials })).status).toBe(400);
    }
    expect((await video("bad" )).status).toBe(400);
    expect((await video(videoModel, {}, { action: "extensions" })).status).toBe(400);
    expect((await video(videoModel, {}, { contentType: "multipart/form-data" })).status).toBe(400);
    expect((await video("minimax.video-gen.from_image")).status).toBe(400);
    expect((await video(videoModel, { provider_options: { invalid_field: true } })).status).toBe(400);
    expect((await video("replicate.video-gen.veo-3.1-fast", { provider_options: { input: { invalid_field: true } } })).status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("never re-sends creation on a connection failure", async () => {
    global.fetch.mockRejectedValueOnce(new Error("socket closed"));
    expect((await video()).status).toBe(502);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
