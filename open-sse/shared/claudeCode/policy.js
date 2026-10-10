import { CLAUDE_CODE } from "../../config/claudeCodeConstants.js";
import { detectClientTool, isClaudeCodeClient } from "../../utils/clientDetector.js";

export function isClaudeCodeRuntimeEnabled(provider, credentials) {
  return Boolean(provider?.startsWith(CLAUDE_CODE.providerPrefix)
    && credentials?.providerSpecificData?.executionMode === CLAUDE_CODE.executionMode);
}

export function isClaudeCodeRuntimeClient({ clientTool, clientMode } = {}) {
  if (clientTool === "claude" || clientMode === CLAUDE_CODE.directMode || clientMode === CLAUDE_CODE.executionMode) return false;
  return clientMode === "harness" || Boolean(clientTool);
}

export function shouldUseClaudeCodeRuntime(provider, { credentials, clientTool, clientMode, body } = {}) {
  if (!isClaudeCodeRuntimeEnabled(provider, credentials)) return false;
  const headers = credentials?.rawHeaders || {};
  if (isClaudeCodeClient(headers)) return false;
  const tool = detectClientTool(headers, body) || clientTool;
  const mode = clientMode || headers[CLAUDE_CODE.clientModeHeader]?.trim().toLowerCase();
  // A declaration can force direct proxying; it can never override native Claude.
  return isClaudeCodeRuntimeClient({ clientTool: tool, clientMode: mode });
}

export class ClaudeCodeBridgeError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "ClaudeCodeBridgeError";
    this.statusCode = statusCode;
  }
}
