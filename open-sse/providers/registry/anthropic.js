import { CLAUDE_CLI_SPOOF_HEADERS } from "../shared.js";

export default {
  id: "anthropic",
  priority: 30,
  alias: "anthropic",
  display: {
    name: "Anthropic",
    icon: "smart_toy",
    color: "#D97757",
    textIcon: "AN",
    website: "https://console.anthropic.com",
    notice: {
      apiKeyUrl: "https://console.anthropic.com/settings/keys",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://api.anthropic.com/v1/messages",
    format: "claude",
    // Claude Code posts to /v1/messages?beta=true; the beta features it asks
    // for in Anthropic-Beta are only honoured on that path.
    urlSuffix: "?beta=true",
    // Present as the Claude Code CLI. The fingerprint is captured from a live
    // client by scripts/capture-claude-headers.mjs — see providers/shared.js.
    // Anthropic-Beta here is the static fallback; default.js recomputes it
    // per-model (heavy-agent + 1M-context flags) in buildHeaders().
    headers: { ...CLAUDE_CLI_SPOOF_HEADERS },
    auth: {
      apiKey: {
        header: "x-api-key",
        scheme: "raw",
      },
      oauth: {
        header: "Authorization",
        scheme: "bearer",
      },
    },
  },
  models: [
    { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
    { id: "claude-opus-4-20250514", name: "Claude Opus 4" },
    { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet" },
  ],
  serviceKinds: ["llm","imageToText"],
};
