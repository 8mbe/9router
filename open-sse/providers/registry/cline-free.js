// Cline free tier — zero-cost models served by the same api.cline.bot endpoint
// as `cline`/`clinepass`, on the same Cline account. Kept as its own provider so
// free traffic gets its own connection, quota and combo slot instead of mixing
// with paid ClinePass/Cline usage.
//
// `models` below is a fallback for when upstream discovery is unavailable; the
// live catalog comes from open-sse/services/clineFreeModels.js (`/models/free`,
// falling back to `/models` filtered to free ids). Cline rotates this list, so
// only ids observed in the live catalog belong here — never invented ones.
export default {
  id: "cline-free",
  priority: 86,
  alias: "clf",
  aliases: [
    "clinefree",
  ],
  uiAlias: "clf",
  display: {
    name: "Cline Free",
    icon: "money_off",
    color: "#5B9BD5",
    textIcon: "CF",
    website: "https://cline.bot",
    notice: {
      text: "Free models on a Cline account. Availability and rate limits are controlled by Cline and change without notice.",
      signupUrl: "https://app.cline.bot",
    },
  },
  category: "freeTier",
  hasFree: true,
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  transport: {
    baseUrl: "https://api.cline.bot/api/v1/chat/completions",
    headers: {
      "HTTP-Referer": "https://cline.bot",
      "X-Title": "Cline",
    },
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
      hooks: [
        "clineHeaders",
      ],
    },
  },
  models: [
    { id: "nvidia/nemotron-3-ultra-550b-a55b:free", name: "Nemotron 3 Ultra 550B (Cline Free)" },
    { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "Nemotron 3 Super 120B (Cline Free)" },
    { id: "nex-agi/nex-n2.5-pro:free", name: "Nex N2.5 Pro (Cline Free)" },
    { id: "nex-agi/nex-n2.5-mini:free", name: "Nex N2.5 Mini (Cline Free)" },
    { id: "thinkingmachines/inkling:free", name: "Inkling (Cline Free)" },
    { id: "thinkingmachines/inkling-small:free", name: "Inkling Small (Cline Free)" },
    { id: "poolside/laguna-s-2.1:free", name: "Laguna S 2.1 (Cline Free)" },
    { id: "poolside/laguna-xs-2.1:free", name: "Laguna XS 2.1 (Cline Free)" },
    { id: "cohere/north-mini-code:free", name: "North Mini Code (Cline Free)" },
    { id: "inclusionai/ling-3.0-flash-fin:free", name: "Ling 3.0 Flash Fin (Cline Free)" },
    { id: "inclusionai/ling-3.0-flash-sante:free", name: "Ling 3.0 Flash Sante (Cline Free)" },
    { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", name: "Nemotron 3 Nano Omni 30B Reasoning (Cline Free)" },
    { id: "nvidia/nemotron-3.5-lightning:free", name: "Nemotron 3.5 Lightning (Cline Free)" },
    { id: "google/gemma-4-31b-it:free", name: "Gemma 4 31B IT (Cline Free)" },
    { id: "google/gemma-4-26b-a4b-it:free", name: "Gemma 4 26B A4B IT (Cline Free)" },
    { id: "dots-studio/dots-3-note-preview:free", name: "Dots 3 Note Preview (Cline Free)" },
    { id: "liquid/lfm-2.5-2.6b:free", name: "LFM 2.5 2.6B (Cline Free)" },
    // Omitted on purpose: nvidia/nemotron-3.5-content-safety:free — a moderation
    // classifier, not a chat model. Live discovery still surfaces it if wanted.
  ],
  oauth: {
    appBaseUrl: "https://app.cline.bot",
    apiBaseUrl: "https://api.cline.bot",
    authorizeUrl: "https://api.cline.bot/api/v1/auth/authorize",
    tokenUrl: "https://api.cline.bot/api/v1/auth/token",
    refreshUrl: "https://api.cline.bot/api/v1/auth/refresh",
  },
  thinkingConfig: {
    options: ["auto", "on", "off"],
    defaultMode: "auto",
  },
};
