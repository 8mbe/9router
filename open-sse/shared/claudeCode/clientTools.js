import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CLAUDE_CODE } from "../../config/claudeCodeConstants.js";
import { CLAUDE_BLOCK } from "../../translator/schema/index.js";

/** Keep client JSON Schema intact instead of translating it through Zod. */
export function createClientToolServer(tools, callTool) {
  const toolNames = new Set(tools.map((tool) => tool.name));
  const instance = new McpServer(
    { name: CLAUDE_CODE.mcpServerName, version: CLAUDE_CODE.mcpServerVersion },
    { capabilities: { tools: {} } },
  );
  instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description || tool.name,
      inputSchema: structuredClone(tool.input_schema),
      // Every relay runs sequentially, so its PreToolUse ID identifies the
      // following tools/call without adding private arguments to its schema.
      annotations: { readOnlyHint: false },
      _meta: { "anthropic/alwaysLoad": true },
    })),
  }));
  instance.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (!toolNames.has(request.params.name)) {
      throw new Error("Claude Code requested an undeclared client tool");
    }
    return callTool(request.params.name, request.params.arguments || {}, extra);
  });
  return {
    type: "sdk",
    name: CLAUDE_CODE.mcpServerName,
    instance,
    alwaysLoad: true,
    timeout: CLAUDE_CODE.toolResultTimeoutMs,
  };
}

/** Convert an Anthropic client result to the MCP result the SDK consumes. */
export function clientToolResultToMcp(result) {
  if (!result || result.type !== CLAUDE_BLOCK.TOOL_RESULT) {
    throw new Error("Expected an Anthropic tool_result for the client tool");
  }
  const blocks = typeof result.content === "string"
    ? [{ type: CLAUDE_BLOCK.TEXT, text: result.content }]
    : result.content || [];
  if (!Array.isArray(blocks)) throw new Error("Invalid client tool result content");
  const content = blocks.map((block) => {
    if (block.type === CLAUDE_BLOCK.TEXT && typeof block.text === "string") {
      return { type: CLAUDE_BLOCK.TEXT, text: block.text };
    }
    if (block.type === CLAUDE_BLOCK.IMAGE && block.source?.type === "base64"
      && typeof block.source.data === "string" && typeof block.source.media_type === "string") {
      return { type: CLAUDE_BLOCK.IMAGE, data: block.source.data, mimeType: block.source.media_type };
    }
    throw new Error("Claude Code client tools support text and base64 image results");
  });
  return { content, isError: result.is_error === true };
}
