import { CLAUDE_CODE } from "../../config/claudeCodeConstants.js";
import { CLAUDE_BLOCK } from "../../translator/schema/index.js";
import { ClaudeCodeBridgeError } from "./policy.js";

const encoder = new TextEncoder();

export function encodeClaudeEvent(event) {
  return encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

export function publicClaudeEvent(event, tools) {
  const result = structuredClone(event);
  if (result.type === "content_block_start" && result.content_block?.type === CLAUDE_BLOCK.TOOL_USE) {
    const name = result.content_block.name;
    const original = name?.startsWith(CLAUDE_CODE.mcpToolPrefix) ? name.slice(CLAUDE_CODE.mcpToolPrefix.length) : name;
    if (!tools.some(tool => tool.name === original)) {
      throw new ClaudeCodeBridgeError(`Claude Code requested an unavailable client tool: ${name}`, 502);
    }
    result.content_block.name = original;
  }
  return result;
}

export class ClaudeMessageAccumulator {
  constructor() {
    this.message = null;
    this.partialInputs = new Map();
  }

  add(event) {
    if (event.type === "message_start") {
      if (this.message) throw new ClaudeCodeBridgeError("Unexpected second assistant generation", 502);
      this.message = { ...structuredClone(event.message), content: [] };
    } else if (event.type === "content_block_start") {
      this.requireMessage();
      this.message.content[event.index] = structuredClone(event.content_block);
    } else if (event.type === "content_block_delta") {
      this.requireMessage();
      const block = this.message.content[event.index];
      if (!block) throw new ClaudeCodeBridgeError("Invalid Claude content block order", 502);
      const delta = event.delta;
      if (delta.type === "text_delta") block.text = (block.text || "") + delta.text;
      else if (delta.type === "thinking_delta") block.thinking = (block.thinking || "") + delta.thinking;
      else if (delta.type === "signature_delta") block.signature = (block.signature || "") + delta.signature;
      else if (delta.type === "input_json_delta") this.partialInputs.set(event.index, (this.partialInputs.get(event.index) || "") + delta.partial_json);
    } else if (event.type === "content_block_stop") {
      if (this.partialInputs.has(event.index)) {
        this.message.content[event.index].input = JSON.parse(this.partialInputs.get(event.index));
        this.partialInputs.delete(event.index);
      }
    } else if (event.type === "message_delta") {
      this.requireMessage();
      Object.assign(this.message, event.delta);
      this.message.usage = { ...this.message.usage, ...event.usage };
    } else if (event.type === "message_stop") {
      this.requireMessage();
      if (this.partialInputs.size) throw new ClaudeCodeBridgeError("Incomplete tool JSON", 502);
    } else if (event.type === "error") {
      throw new ClaudeCodeBridgeError(event.error?.message || "Claude Code upstream error", 502);
    }
  }

  requireMessage() {
    if (!this.message) throw new ClaudeCodeBridgeError("Missing Claude message_start", 502);
  }
}
