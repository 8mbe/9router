import { BaseExecutor } from "./base.js";
import { DefaultExecutor } from "./default.js";
import { FORMATS } from "../translator/formats.js";
import { CLAUDE_CODE } from "../config/claudeCodeConstants.js";
import { shouldUseClaudeCodeRuntime, ClaudeCodeBridgeError } from "../shared/claudeCode/policy.js";
import { runClaudeCodeTurn } from "../shared/claudeCode/sessions.js";
import { claudeCodeRuntimeHop } from "../shared/claudeCode/loopGuard.js";

export class ClaudeCodeRuntimeExecutor extends BaseExecutor {
  constructor(provider, createWorker = null) {
    super(provider, { noAuth: true });
    this.createWorker = createWorker;
  }

  async execute(options) {
    const { model, body, credentials, clientTool, signal, stream = true, proxyOptions } = options;
    const clientMode = credentials?.clientMode;
    // Defense in depth: a native Claude request never imports or starts the SDK.
    if (!shouldUseClaudeCodeRuntime(this.provider, { credentials, clientTool, clientMode, body })) {
      return new DefaultExecutor(this.provider).execute(options);
    }
    if (proxyOptions?.connectionProxyEnabled || proxyOptions?.vercelRelayUrl) {
      throw new ClaudeCodeBridgeError("Server Claude Code does not support connection proxy/relay settings yet; use direct execution");
    }
    const baseUrl = credentials?.providerSpecificData?.baseUrl;
    if (!baseUrl) throw new ClaudeCodeBridgeError("Configure a custom Anthropic upstream URL");
    let upstream;
    try { upstream = new URL(baseUrl); } catch { throw new ClaudeCodeBridgeError("Invalid custom Anthropic upstream URL"); }
    if (!["https:", "http:"].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash) throw new ClaudeCodeBridgeError("Invalid custom Anthropic upstream URL");
    const endpoint = credentials?.runtimeRequestUrl;
    if (endpoint) {
      const inbound = new URL(endpoint);
      if (inbound.origin === upstream.origin) throw new ClaudeCodeBridgeError("Claude Code upstream must not point back to this router");
    }
    const apiKey = credentials?.apiKey;
    if (!apiKey) throw new ClaudeCodeBridgeError("Configure an upstream API key for server Claude Code");
    const createWorker = this.createWorker || (await import("../shared/claudeCode/runtime.js")).createClaudeCodeWorker;
    const { session, turn } = await runClaudeCodeTurn({
      body, model, provider: this.provider,
      ownerId: credentials.runtimeOwnerId,
      connectionId: credentials.connectionId,
      conversationId: credentials.runtimeSessionId || credentials.runtimeConversationId,
      signal, createWorker,
      workerOptions: { upstreamBaseUrl: baseUrl, apiKey, authMode: credentials.providerSpecificData?.authMode || "api-key", runtimeHop: claudeCodeRuntimeHop() },
    });
    const headers = { [CLAUDE_CODE.sessionHeader]: session.id, "x-should-retry": "false" };
    // Attach the response stream before settling results and restarting generation.
    const responseBody = stream ? turn.stream() : null;
    await turn.start?.();
    await turn.first.promise;
    const response = stream
      ? new Response(responseBody, { headers: { ...headers, "content-type": "text/event-stream" } })
      : new Response(JSON.stringify(await turn.done.promise), { headers: { ...headers, "content-type": "application/json" } });
    return { response, url: `${baseUrl.replace(/\/$/, "")}/messages`, headers: {}, transformedBody: body, responseFormat: FORMATS.CLAUDE };
  }
}
