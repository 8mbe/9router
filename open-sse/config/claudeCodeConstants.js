// Server Claude Code is opt-in and only used for declared non-Claude clients.
export const CLAUDE_CODE = Object.freeze({
  providerPrefix: "anthropic-compatible-",
  executionMode: "claude-code",
  directMode: "direct",
  clientModeHeader: "x-9router-client-mode",
  sessionHeader: "x-9router-session-id",
  runtimeHopHeader: "x-9router-runtime-hop",
  mcpServerName: "client",
  mcpServerVersion: "1.0.0",
  mcpToolPrefix: "mcp__client__",
  idleTimeoutMs: 15 * 60 * 1000,
  generationTimeoutMs: 5 * 60 * 1000,
  shutdownTimeoutMs: 5000,
  toolResultTimeoutMs: 15 * 60 * 1000,
  hookTimeoutSeconds: 16 * 60,
  maxSessions: 64,
  modelProbeConcurrency: 4,
  maxToolResultBytes: 8 * 1024 * 1024,
  maxHistoryBytes: 16 * 1024 * 1024,
  maxResponseBytes: 16 * 1024 * 1024,
});

export const CLAUDE_CODE_SESSION_STATE = Object.freeze({
  GENERATING: "generating",
  WAITING: "waitingForResults",
  READY: "ready",
  EXPIRED: "expired",
  FAILED: "failed",
});
