import { randomUUID } from "node:crypto";
import { CLAUDE_CODE } from "../../config/claudeCodeConstants.js";
import { ClaudeCodeBridgeError } from "./policy.js";

const identity = Symbol.for("9router.claudeCode.runtimeHop");

export function claudeCodeRuntimeHop() {
  return globalThis[identity] ||= randomUUID();
}

export function assertNoClaudeCodeLoop(headers) {
  const hops = typeof headers?.get === "function" ? headers.get(CLAUDE_CODE.runtimeHopHeader) : headers?.[CLAUDE_CODE.runtimeHopHeader];
  if (hops?.split(",").map(hop => hop.trim()).includes(claudeCodeRuntimeHop())) {
    throw new ClaudeCodeBridgeError("Claude Code upstream loops back to this router", 409);
  }
}
