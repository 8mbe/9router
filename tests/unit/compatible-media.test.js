import { afterEach, describe, expect, it, vi } from "vitest";
import { handleImageGenerationCore } from "open-sse/handlers/imageGenerationCore.js";
import { getImageAdapter } from "open-sse/handlers/imageProviders/index.js";
import { handleTtsCore } from "open-sse/handlers/ttsCore.js";
import { handleSttCore } from "open-sse/handlers/sttCore.js";
import { inferCompatibleModelKind, normalizeCompatibleMediaKinds } from "@/shared/utils/compatibleMedia";

const provider = "openai-compatible-chat-test";
const credentials = {
  apiKey: "test-key",
  providerSpecificData: { baseUrl: "https://media.example/v1/" },
};

afterEach(() => vi.unstubAllGlobals());

describe("OpenAI-compatible media nodes", () => {
  it("forwards image generation to the configured endpoint with the full upstream model ID", async () => {
    const fetchMock = vi.fn(async () => Response.json({ created: 1, data: [{ url: "https://image.example/1.png" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await handleImageGenerationCore({
      body: { model: "custom/agi/gpt-image-1", prompt: "a cat", background: "transparent" },
      modelInfo: { provider, model: "agi/gpt-image-1" },
      credentials,
    });
    expect(result.success).toBe(true);
    expect(await result.response.json()).toEqual({ created: 1, data: [{ url: "https://image.example/1.png" }] });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://media.example/v1/images/generations");
    expect(options.headers.Authorization).toBe("Bearer test-key");
    expect(JSON.parse(options.body).model).toBe("agi/gpt-image-1");
    expect(JSON.parse(options.body).background).toBe("transparent");
  });

  it("forwards speech using the model path and requested voice", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      headers: { "Content-Type": "audio/mpeg" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await handleTtsCore({
      provider, model: "nvidia/fastpitch", input: "Hello", credentials,
      responseFormat: "json", voice: "speaker-a",
    });
    expect(result.success).toBe(true);
    expect((await result.response.json()).audio).toBe("AQID");
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://media.example/v1/audio/speech");
    expect(JSON.parse(options.body)).toEqual({ model: "nvidia/fastpitch", input: "Hello", voice: "speaker-a" });
  });

  it("forwards multipart transcription to the configured endpoint", async () => {
    const fetchMock = vi.fn(async () => Response.json({ text: "Hello" }));
    vi.stubGlobal("fetch", fetchMock);
    const formData = new FormData();
    formData.append("file", new File(["audio"], "sample.wav", { type: "audio/wav" }));
    const result = await handleSttCore({
      provider, model: "dg/nova-3", formData, credentials,
      sttConfig: { format: "openai", authType: "apikey", baseUrl: "" },
    });
    expect(result.success).toBe(true);
    expect(await result.response.json()).toEqual({ text: "Hello" });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://media.example/v1/audio/transcriptions");
    expect(options.body.get("model")).toBe("dg/nova-3");
  });

  it("keeps media capability selection constrained to supported routes", () => {
    expect(normalizeCompatibleMediaKinds(["video", "image", "stt", "image"])).toEqual(["image", "stt"]);
    expect(inferCompatibleModelKind({ id: "vendor/gpt-image", capabilities: { imageOutput: true } })).toBe("image");
    expect(inferCompatibleModelKind({ id: "vendor/gemini-pro", capabilities: { imageOutput: true } })).toBe("llm");
    expect(inferCompatibleModelKind({ id: "dg/nova-3" })).toBe("llm");
    expect(getImageAdapter("tokenrouter")).toBeTruthy();
    expect(getImageAdapter("venice")).toBeTruthy();
  });
});
