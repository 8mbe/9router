export const COMPATIBLE_MEDIA_KINDS = ["image", "embedding", "tts", "stt"];

export function normalizeCompatibleMediaKinds(value) {
  if (!Array.isArray(value)) return [];
  return COMPATIBLE_MEDIA_KINDS.filter((kind) => value.includes(kind));
}

export function inferCompatibleModelKind(model) {
  const id = String(model?.id || model?.name || model?.model || "").toLowerCase();
  if (/(?:^|[\/_-])(?:embed(?:ding)?|bge|e5)(?:[\/_-]|$)/.test(id)) return "embedding";
  if (/(?:^|[\/_-])(?:tts|speech|voice)(?:[\/_-]|$)/.test(id)) return "tts";
  if (/(?:^|[\/_-])(?:whisper|transcri(?:be|ption)|asr|stt)(?:[\/_-]|$)/.test(id)) return "stt";
  if (/(?:^|[\/_-])(?:image|imagen|dall-e|flux|sdxl|seedream)(?:[\/_-]|$)/.test(id)) return "image";
  return "llm";
}
