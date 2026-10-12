import { TREG_CONFIG, TREG_ROUTES } from "../../config/treg.js";

const models = Object.entries(TREG_ROUTES).map(([id, route]) => ({
  id, name: route.name, kind: route.kind,
  ...(["image", "video"].includes(route.kind) ? { capabilities: [
    ...(route.kind === "image" ? ["text2img"] : []),
    ...(route.format === "google-image" || route.format === "minimax-h3" || route.fields?.some((field) => ["image", "first_frame_image", "image_urls", "image_input", "input_images"].includes(field)) ? ["edit"] : []),
  ] } : {}),
  ...(route.kind === "image" ? { params: ["size", "response_format", ...(route.fields?.some((field) => ["n", "num_outputs", "number_of_images"].includes(field)) ? ["n"] : [])] } : {}),
  ...(route.kind === "video" ? { params: ["duration", "resolution", "aspect_ratio"] } : {}),
}));

export default {
  id: "treg",
  alias: "treg",
  category: "apikey",
  authType: "apikey",
  display: {
    name: "Treg",
    icon: "hub",
    color: "#E66B32",
    textIcon: "TR",
    website: TREG_CONFIG.baseUrl,
    notice: { apiKeyUrl: TREG_CONFIG.baseUrl, text: "Use a Treg organization API token. Calls use your connected provider keys or your team's prepaid balance." },
  },
  serviceKinds: ["image", "video", "tts", "webSearch", "webFetch"],
  imageConfig: { baseUrl: `${TREG_CONFIG.baseUrl}/call`, authType: "apikey", authHeader: "X-Treg-Token" },
  videoConfig: { baseUrl: `${TREG_CONFIG.baseUrl}/call` },
  ttsConfig: { baseUrl: `${TREG_CONFIG.baseUrl}/call`, authType: "apikey", authHeader: "X-Treg-Token", format: "treg", models: models.filter((model) => model.kind === "tts") },
  searchConfig: { baseUrl: `${TREG_CONFIG.baseUrl}/call/treg.web.search`, method: "POST", authType: "apikey", authHeader: "X-Treg-Token", searchTypes: ["web"], defaultMaxResults: 5, maxMaxResults: 100, costPerQuery: null },
  fetchConfig: { baseUrl: `${TREG_CONFIG.baseUrl}/call/treg.web.extract`, method: "POST", authType: "apikey", authHeader: "X-Treg-Token", formats: ["markdown", "text"], costPerQuery: null },
  models,
};
