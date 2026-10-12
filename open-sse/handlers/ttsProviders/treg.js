import { Buffer } from "node:buffer";
import { TREG_CONFIG, TREG_ROUTES } from "../../config/treg.js";
import { assertTregResponse, buildTregCallUrl, buildTregHeaders, getTregRoute } from "../treg/client.js";
import { fetchPublic } from "../../../src/shared/utils/ssrfGuard.js";
import { parseModelVoice } from "./_base.js";

const ttsModels = Object.keys(TREG_ROUTES).filter((id) => TREG_ROUTES[id].kind === "tts");

async function audioToBase64(response, format) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("json") || contentType.includes("text/")) {
    throw new Error("Treg TTS returned an invalid audio response");
  }
  const bytes = await response.arrayBuffer();
  if (!bytes.byteLength) throw new Error("Treg TTS returned no audio");
  return { base64: Buffer.from(bytes).toString("base64"), format };
}

function resolveAudioFormat(route, responseFormat) {
  const format = responseFormat === "json"
    ? route.defaults.audio_setting?.format || route.defaults.format
    : responseFormat;
  if (!route.formats.includes(format)) throw new Error(`Unsupported Treg TTS audio format: ${format}`);
  return format;
}

function resolveVoice(voice, parsedVoice) {
  if (voice != null && typeof voice !== "string") throw new Error("Treg TTS voice must be a string");
  return voice?.trim() || parsedVoice;
}

async function synthesizeMiniMax(text, route, endpoint, credentials, format, voiceId) {
  const body = {
    ...route.defaults,
    text,
    voice_setting: { ...route.defaults.voice_setting },
    audio_setting: { ...route.defaults.audio_setting, format },
  };
  if (voiceId) body.voice_setting.voice_id = voiceId;
  if (format !== route.defaults.audio_setting.format) delete body.audio_setting.bitrate;

  const response = await fetch(buildTregCallUrl(endpoint), {
    method: "POST",
    headers: buildTregHeaders(credentials),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TREG_CONFIG.httpTimeoutMs),
    redirect: "error",
  });
  await assertTregResponse(response, credentials);
  const data = await response.json();
  const statusCode = Number(data?.base_resp?.status_code ?? 0);
  if (statusCode !== 0) throw new Error(`Treg TTS provider error (${statusCode})`);
  const audioUrl = data?.data?.audio;
  if (typeof audioUrl !== "string" || !audioUrl) throw new Error("Treg TTS returned no audio URL");
  const parsedUrl = new URL(audioUrl);
  if (!["http:", "https:"].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
    throw new Error("Treg TTS returned an invalid audio URL");
  }
  // The result URL is public; Treg credentials stay on the submission request.
  const audioResponse = await fetchPublic(audioUrl, { signal: AbortSignal.timeout(TREG_CONFIG.httpTimeoutMs) });
  if (!audioResponse.ok) throw new Error(`Treg audio download failed (${audioResponse.status})`);
  return audioToBase64(audioResponse, format);
}

async function synthesizeFish(text, route, endpoint, credentials, format, voiceId) {
  const body = { text, format };
  if (voiceId) body.reference_id = voiceId;
  const response = await fetch(buildTregCallUrl(endpoint), {
    method: "POST",
    headers: buildTregHeaders(credentials, { model: route.defaults.model, Accept: "audio/*" }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TREG_CONFIG.httpTimeoutMs),
    redirect: "error",
  });
  await assertTregResponse(response, credentials);
  return audioToBase64(response, format);
}

export default {
  async synthesize(text, model, credentials, responseFormat = "mp3", { voice } = {}) {
    if (model && !ttsModels.some((id) => model === id || model.startsWith(`${id}/`))) {
      throw new Error(`Unsupported Treg TTS model: ${model}`);
    }
    const { modelId, voiceId } = parseModelVoice(model, ttsModels[0], "", ttsModels);
    const route = getTregRoute(modelId, "tts");
    const format = resolveAudioFormat(route, responseFormat);
    const selectedVoice = resolveVoice(voice, voiceId);
    if (route.format === "minimax-tts") return synthesizeMiniMax(text, route, modelId, credentials, format, selectedVoice);
    if (route.format === "fish-tts") return synthesizeFish(text, route, modelId, credentials, format, selectedVoice);
    throw new Error(`Unsupported Treg TTS route: ${modelId}`);
  },
};
