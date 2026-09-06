import { platform, arch } from "os";
import { randomUUID } from "crypto";

// === OS/Arch helpers (Stainless fingerprint) ===
export function mapStainlessOs() {
  switch (platform()) {
    case "darwin": return "MacOS";
    case "win32": return "Windows";
    case "linux": return "Linux";
    case "freebsd": return "FreeBSD";
    default: return `Other::${platform()}`;
  }
}

export function mapStainlessArch() {
  switch (arch()) {
    case "x64": return "x64";
    case "arm64": return "arm64";
    case "ia32": return "x86";
    default: return `other::${arch()}`;
  }
}

// Anthropic API version (single source — reused across claude-format providers/executors)
export const ANTHROPIC_API_VERSION = "2023-06-01";

// === Claude Code client fingerprint ===
// Captured from a live `claude` CLI with scripts/capture-claude-headers.mjs
// (a reverse proxy that records the real request before forwarding it upstream).
// Re-run that script after a CLI upgrade and refresh the three constants below
// rather than guessing — providers such as agentrouter gate on this identity.
export const CLAUDE_CLI_VERSION = "2.1.263";
export const CLAUDE_SDK_VERSION = "0.112.1";   // X-Stainless-Package-Version
export const CLAUDE_NODE_VERSION = "v26.3.0";  // X-Stainless-Runtime-Version

// Shared Claude-compatible API headers (reused across claude-format providers
// that merely speak the Anthropic wire format — GLM, Kimi, MiniMax, DeepSeek…).
// Deliberately minimal: those upstreams are not Anthropic and must not receive
// the Claude Code identity headers below.
export const CLAUDE_API_HEADERS = {
  "Anthropic-Version": ANTHROPIC_API_VERSION,
  "Anthropic-Beta": "claude-code-20250219,interleaved-thinking-2025-05-14"
};

// Beta flags Claude Code sends on every request (captured 2026-09; see above).
// `context-1m-2025-08-07` is deliberately NOT here: the CLI only sends it when
// the user opted into 1M context (the `[1m]` model marker), and turning it on
// unconditionally would change the context window and the billing rate for
// every request. `oauth-2025-04-20` is added by the OAuth path only.
const ANTHROPIC_BETA_BASE = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "thinking-token-count-2026-05-13",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "mid-conversation-system-2026-04-07",
  "advisor-tool-2026-03-01",
  "structured-outputs-2025-12-15",
  "fast-mode-2026-02-01",
  "redact-thinking-2026-02-12",
  "token-efficient-tools-2026-03-28",
  "fallback-credit-2026-06-01",
];
const ANTHROPIC_BETA_HEAVY_AGENT = ["advanced-tool-use-2025-11-20", "effort-2025-11-24"];

// The 1M-context beta rides on the `[1m]` model marker the client appends.
export const ANTHROPIC_BETA_CONTEXT_1M = "context-1m-2025-08-07";

// Heavy-agent beta flags are gated to opus/sonnet — cheaper models don't need them.
// `contextMarker` is the marker stripped off the model id (see utils/modelMarkers.js);
// pass "1m" through to re-attach the 1M-context flag the client asked for.
export function selectAnthropicBeta(model = "", contextMarker = null) {
  const flags = [...ANTHROPIC_BETA_BASE];
  if (/^claude-(opus|sonnet)/.test(model)) flags.push(...ANTHROPIC_BETA_HEAVY_AGENT);
  if (contextMarker === "1m") flags.push(ANTHROPIC_BETA_CONTEXT_1M);
  return flags.join(",");
}

// Full Claude CLI fingerprint — for providers that gate on client identity.
// Header names/casing match the capture exactly (note `X-Stainless-OS`, not
// `-Os`); `X-Stainless-Helper-Method` is gone from current CLI builds.
export const CLAUDE_CLI_SPOOF_HEADERS = {
  "Anthropic-Version": ANTHROPIC_API_VERSION,
  "Anthropic-Beta": selectAnthropicBeta(),
  "Anthropic-Dangerous-Direct-Browser-Access": "true",
  "User-Agent": `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`,
  "X-App": "cli",
  "X-Stainless-Retry-Count": "0",
  "X-Stainless-Runtime-Version": CLAUDE_NODE_VERSION,
  "X-Stainless-Package-Version": CLAUDE_SDK_VERSION,
  "X-Stainless-Runtime": "node",
  "X-Stainless-Lang": "js",
  "X-Stainless-Arch": mapStainlessArch(),
  "X-Stainless-OS": mapStainlessOs(),
  "X-Stainless-Timeout": "600"
};

// Claude Code stamps a stable session UUID on every request in a session.
// One 9router process = one session, so the id is generated once and reused.
let _claudeCodeSessionId = null;
export function claudeCodeSessionId() {
  if (!_claudeCodeSessionId) _claudeCodeSessionId = randomUUID();
  return _claudeCodeSessionId;
}

// Shared baseUrls
export const KIMI_CODING_BASE_URL = "https://api.kimi.com/coding/v1/messages";

// Default base for dynamic compat providers (openai-compatible-* / anthropic-compatible-*) when user gives no baseUrl
export const OPENAI_COMPAT_BASE = "https://api.openai.com/v1";
export const ANTHROPIC_COMPAT_BASE = "https://api.anthropic.com/v1";

// Official Antigravity IDE Desktop 2.11.0 fingerprint captured from macOS arm64.
// Keep this static even when 9router runs on Linux: the provider profile is
// intentionally matching the IDE client, not the server host.
export const ANTIGRAVITY_IDE_VERSION = "2.11.0";
export const ANTIGRAVITY_IDE_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_IDE_USER_AGENT = `antigravity/ide/${ANTIGRAVITY_IDE_VERSION} darwin/arm64`;

// Antigravity OAuth client credentials (public CLI client — duplicated in usage.js + src/lib/oauth)
export const ANTIGRAVITY_OAUTH_CLIENT = {
  clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  clientSecret: "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"
};

// Gemini (Google) OAuth client credentials (public CLI client — shared by gemini, gemini-cli, src/lib/oauth)
export const GOOGLE_OAUTH_CLIENT = {
  clientId: "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
  clientSecret: "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"
};
