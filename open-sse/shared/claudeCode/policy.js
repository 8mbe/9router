import { CLAUDE_CODE } from "../../config/claudeCodeConstants.js";
import { detectClientTool } from "../../utils/clientDetector.js";

export function isClaudeCodeRuntimeClient({ clientTool, clientMode } = {}) {
  if (clientTool === "claude" || clientMode === CLAUDE_CODE.directMode || clientMode === CLAUDE_CODE.executionMode) return false;
  return clientMode === "harness" || Boolean(clientTool);
}

export function shouldUseClaudeCodeRuntime(provider, { credentials, clientTool, clientMode, body } = {}) {
  if (!provider?.startsWith(CLAUDE_CODE.providerPrefix)) return false;
  if (credentials?.providerSpecificData?.executionMode !== CLAUDE_CODE.executionMode) return false;
  const headers = credentials?.rawHeaders || {};
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
