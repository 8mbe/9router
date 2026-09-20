export default {
  id: "cline",
  priority: 80,
  alias: "cl",
  uiAlias: "cl",
  display: {
    name: "Cline",
    icon: "smart_toy",
    color: "#5B9BD5",
    textIcon: "CL",
    website: "https://cline.bot",
    notice: {
      signupUrl: "https://cline.bot",
    },
  },
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  transport: {
    baseUrl: "https://api.cline.bot/api/v1/chat/completions",
    headers: {
      "HTTP-Referer": "https://cline.bot",
      "X-Title": "Cline",
    },
    // Non-stream chat completions come back wrapped in {"success":true,"data":{...}}
    quirks: { clineEnvelope: true },
    tokenUrl: "https://api.cline.bot/api/v1/auth/token",
    refreshUrl: "https://api.cline.bot/api/v1/auth/refresh",
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
    { id: "anthropic/claude-opus-4.7", name: "Claude Opus 4.7" },
    { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
    { id: "anthropic/claude-opus-4.6", name: "Claude Opus 4.6" },
    { id: "openai/gpt-5.3-codex", name: "GPT-5.3 Codex" },
    { id: "openai/gpt-5.4", name: "GPT-5.4" },
    { id: "google/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview" },
    { id: "google/gemini-3.1-flash-lite-preview", name: "Gemini 3.1 Flash Lite Preview" },
    { id: "kwaipilot/kat-coder-pro", name: "KAT Coder Pro" },
    // Cline's free plan, in the order Cline's own picker lists it. This is the
    // `free` feed from /ai/cline/recommended-models, not every zero-priced id in
    // the catalog: most of the vendors' `:free` models are dead ends that only
    // fail on the first request. The live catalog is still merged over this list
    // when a connection can reach Cline.
    { id: "cline-free/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash (free)", contextLength: 1048576 },
    { id: "cline-free/muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor (free)", contextLength: 1048576 },
    // Free on Cline's plan although the catalog quotes a price for it.
    { id: "z-ai/glm-5.3-flash", name: "GLM-5.3-Flash (free)", contextLength: 1310720 },
    { id: "cline-free/solar-pro4", name: "Solar Pro 4 (free)", contextLength: 524288 },
    { id: "poolside/laguna-s-2.1:free", name: "Laguna S 2.1 (free)", contextLength: 262144 },
  ],
  oauth: {
    appBaseUrl: "https://app.cline.bot",
    apiBaseUrl: "https://api.cline.bot",
    authorizeUrl: "https://api.cline.bot/api/v1/auth/authorize",
    tokenExchangeUrl: "https://api.cline.bot/api/v1/auth/token",
    refreshUrl: "https://api.cline.bot/api/v1/auth/refresh",
  },
};
