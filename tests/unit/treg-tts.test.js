import dns from "node:dns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleTtsCore } from "../../open-sse/handlers/ttsCore.js";
import treg from "../../open-sse/handlers/ttsProviders/treg.js";
import { TTS_PROVIDER_CONFIG } from "../../src/shared/constants/ttsProviders.js";

const HD = "minimax.voice-gen.speech-2-8-hd";
const TURBO = "minimax.voice-gen.speech-2-8-turbo";
const FISH = "fishaudio.tts.s2-1-pro";
const AUDIO = new Uint8Array(256).fill(7);
const AUDIO_URL = "https://audio.example.com/result.mp3";
const credentials = { apiKey: "treg-test-token", providerSpecificData: { org: "test-team" } };

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function audioResponse(format = "mpeg") {
  return new Response(AUDIO, { headers: { "Content-Type": `audio/${format}` } });
}

function miniMaxSuccess() {
  return jsonResponse({ data: { audio: AUDIO_URL }, base_resp: { status_code: 0, status_msg: "success" } });
}

describe("Treg TTS", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(dns.promises, "lookup").mockResolvedValue([{ address: "203.0.113.20", family: 4 }]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("routes MiniMax speech, returns base64 JSON, and keeps the token off the public download", async () => {
    fetch.mockResolvedValueOnce(miniMaxSuccess()).mockResolvedValueOnce(audioResponse());

    const result = await handleTtsCore({
      provider: "treg", model: `${HD}/English_radiant_girl`, input: " Hello. ", credentials, responseFormat: "json",
    });

    expect(result.success).toBe(true);
    expect(await result.response.json()).toEqual({ audio: Buffer.from(AUDIO).toString("base64"), format: "mp3" });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`https://treg.to/call/${HD}`);
    expect(init.headers).toMatchObject({ "X-Treg-Token": "treg-test-token", "X-Treg-Org": "test-team" });
    expect(init.headers).not.toHaveProperty("Authorization");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body)).toMatchObject({
      model: "speech-2.8-hd", text: "Hello.", stream: false, output_format: "url",
      voice_setting: { voice_id: "English_radiant_girl", speed: 1, vol: 1, pitch: 0 },
      audio_setting: { format: "mp3", sample_rate: 32000, bitrate: 128000, channel: 1 },
    });
    expect(fetch.mock.calls[1][0]).toBe(AUDIO_URL);
    expect(fetch.mock.calls[1][1]).not.toHaveProperty("headers");
    expect(fetch.mock.calls[1][1].redirect).toBe("manual");
  });

  it("uses the default MiniMax voice and removes MP3 bitrate for WAV output", async () => {
    fetch.mockResolvedValueOnce(miniMaxSuccess()).mockResolvedValueOnce(audioResponse("wav"));
    const result = await treg.synthesize("Hello", TURBO, credentials, "wav");
    const sent = JSON.parse(fetch.mock.calls[0][1].body);
    expect(sent.model).toBe("speech-2.8-turbo");
    expect(sent.voice_setting.voice_id).toBe("English_expressive_narrator");
    expect(sent.audio_setting.format).toBe("wav");
    expect(sent.audio_setting).not.toHaveProperty("bitrate");
    expect(result).toEqual({ base64: Buffer.from(AUDIO).toString("base64"), format: "wav" });
  });

  it("uses the configured first TTS route when the model is omitted", async () => {
    fetch.mockResolvedValueOnce(miniMaxSuccess()).mockResolvedValueOnce(audioResponse());
    await treg.synthesize("Hello", undefined, credentials, "json");
    expect(fetch.mock.calls[0][0]).toBe(`https://treg.to/call/${HD}`);
  });

  it("requests Fish binary audio using its model header and omits an unset voice", async () => {
    fetch.mockResolvedValueOnce(audioResponse());
    const result = await handleTtsCore({ provider: "treg", model: FISH, input: "Hello", credentials, responseFormat: "json" });
    expect(result.success).toBe(true);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`https://treg.to/call/${FISH}`);
    expect(init.headers).toMatchObject({ model: "s2.1-pro", "X-Treg-Token": "treg-test-token", Accept: "audio/*" });
    expect(JSON.parse(init.body)).toEqual({ text: "Hello", format: "mp3" });
    expect(await result.response.json()).toEqual({ audio: Buffer.from(AUDIO).toString("base64"), format: "mp3" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(TTS_PROVIDER_CONFIG.treg).not.toHaveProperty("defaultVoiceId");
  });

  it("honors a separate voice argument ahead of a model suffix for both providers", async () => {
    fetch.mockResolvedValueOnce(audioResponse("opus"));
    await treg.synthesize("Hello", `${FISH}/suffix-voice`, credentials, "opus", { voice: "public-voice" });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ text: "Hello", format: "opus", reference_id: "public-voice" });

    fetch.mockResolvedValueOnce(miniMaxSuccess()).mockResolvedValueOnce(audioResponse());
    await treg.synthesize("Hello", `${HD}/suffix-voice`, credentials, "mp3", { voice: "English_radiant_girl" });
    expect(JSON.parse(fetch.mock.calls[1][1].body).voice_setting.voice_id).toBe("English_radiant_girl");
  });

  it("rejects unsupported models and audio formats before a billed call", async () => {
    await expect(treg.synthesize("Hello", "unknown-model", credentials)).rejects.toThrow("Unsupported Treg TTS model");
    await expect(treg.synthesize("Hello", HD, credentials, "aac")).rejects.toThrow("Unsupported Treg TTS audio format");
    await expect(treg.synthesize("Hello", FISH, credentials, "mp3", { voice: 42 })).rejects.toThrow("voice must be a string");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces a Treg payment error without retrying generation", async () => {
    fetch.mockResolvedValueOnce(jsonResponse({ detail: { error: "route_max_cost", message: "Treg balance is too low" } }, 402));
    const result = await handleTtsCore({ provider: "treg", model: FISH, input: "Hello", credentials });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Treg balance is too low");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a MiniMax semantic error and never fetches its result URL", async () => {
    fetch.mockResolvedValueOnce(jsonResponse({ data: { audio: AUDIO_URL }, base_resp: { status_code: 2013, status_msg: "invalid voice" } }));
    await expect(treg.synthesize("Hello", HD, credentials)).rejects.toThrow("Treg TTS provider error (2013)");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("blocks private audio URLs and public URLs redirecting to private hosts", async () => {
    fetch.mockResolvedValueOnce(jsonResponse({ data: { audio: "http://127.0.0.1/private" } }));
    await expect(treg.synthesize("Hello", HD, credentials)).rejects.toThrow("Blocked URL");
    expect(fetch).toHaveBeenCalledTimes(1);

    fetch.mockResolvedValueOnce(miniMaxSuccess()).mockResolvedValueOnce(new Response(null, {
      status: 302, headers: { Location: "http://169.254.169.254/latest/meta-data" },
    }));
    await expect(treg.synthesize("Hello", HD, credentials)).rejects.toThrow("Blocked URL");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("rejects successful JSON masquerading as Fish audio", async () => {
    fetch.mockResolvedValueOnce(jsonResponse({ error: "not audio" }));
    await expect(treg.synthesize("Hello", FISH, credentials)).rejects.toThrow("invalid audio response");
  });

  it("does not resubmit a paid MiniMax generation when the download fails", async () => {
    fetch.mockResolvedValueOnce(miniMaxSuccess()).mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(treg.synthesize("Hello", HD, credentials)).rejects.toThrow("Treg audio download failed (503)");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
