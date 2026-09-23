// Codebuff (codebuff.com, internally "Freebuff") free tier.
//
// The upstream chat route is OpenAI-shaped, but it is NOT reachable with a
// bare Bearer token: the free-mode gate (403 free_mode_cli_required) requires
// the official CLI's request envelope, and every chat call must run inside a
// purchased session + registered agent run. All of that lives in
// executors/codebuff.js — this entry only carries transport + catalog.
//
// Catalog mirrors the upstream rows that are actually served on a free
// account. Paused rows (ox-alpha, deepseek-v4-pro, minimax-m3, glm-5.2,
// muse-spark-1.3), plan-gated rows (gemini-3.8-flash, mimo-v2.6-pro) and the
// limited-offer row (claude-fable-5.1) are deliberately omitted: upstream
// refuses admission for them, so advertising them would only produce errors.
export default {
  id: "codebuff",
  alias: "cb",
  aliases: ["freebuff"],
  uiAlias: "cb",
  category: "freeTier",
  authType: "oauth",
  hasOAuth: true,
  authModes: ["oauth"],
  display: {
    name: "Codebuff",
    icon: "savings",
    color: "#16A34A",
    textIcon: "CB",
    website: "https://www.codebuff.com",
    notice: {
      signupUrl: "https://www.codebuff.com",
    },
  },
  transport: {
    baseUrl: "https://www.codebuff.com/api/v1/chat/completions",
    format: "openai",
    // Upstream only answers streaming chat; the envelope forces stream:true.
    forceStream: true,
    retry: {
      429: { attempts: 2, delayMs: 5000 },
    },
  },
  models: [
    { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash" },
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4.1 Flash" },
    { id: "openai/gpt-6-luna", name: "GPT-6 Luna" },
    { id: "mimo/mimo-v2.5", name: "MiMo 2.6 Flash" },
    { id: "upstage/solar-pro4", name: "Solar Pro 4" },
    { id: "meta/muse-spark-1.2-contributor", name: "Muse Spark 1.2" },
  ],
  oauth: {
    // Device-code-shaped login: POST code → user approves in browser → poll status.
    baseUrl: "https://www.codebuff.com",
    deviceCodeUrl: "https://www.codebuff.com/api/auth/cli/code",
    tokenUrl: "https://www.codebuff.com/api/auth/cli/status",
    userInfoUrl: "https://www.codebuff.com/api/v1/me",
  },
  thinkingConfig: {
    options: ["auto", "none", "low", "medium", "high", "max"],
    defaultMode: "auto",
  },
};
