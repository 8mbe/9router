import "open-sse/index.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";
import { getProviderConnections, getSettings } from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { probeConnectionModel } from "@/lib/modelProbe/probe";
import { consumeProbeStream, ESSAY_PROMPT, ESSAY_TIMEOUT_MS, PING_PROMPT } from "@/lib/modelProbe/streamMetrics";
import { getModelInfo } from "@/sse/services/model";
import { getProviderCredentials } from "@/sse/services/auth";
import { checkAndRefreshToken, updateProviderCredentials } from "@/sse/services/tokenRefresh";
import * as log from "@/sse/utils/logger";
import { FREE_PROVIDERS, isAnthropicCompatibleProvider, isOpenAICompatibleProvider } from "@/shared/constants/providers";
import { aggregateModelTestResults } from "@/shared/utils/modelTestResults";
import { pingModelByKind } from "./ping";

const TEST_TIMEOUT_MS = { ping: 15000, essay: ESSAY_TIMEOUT_MS };

function withAbortError(result, signal, requestSignal, timeoutMs) {
  return signal.aborted
    ? { ...result, ok: false, error: requestSignal?.aborted ? "Test canceled" : `Timed out after ${timeoutMs}ms` }
    : result;
}

async function probeProviderConnection(connection, modelInfo, testType, signal, settings) {
  const startTime = Date.now();
  const { provider, model } = modelInfo;
  const proxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
  let credentials = {
    ...connection,
    connectionId: connection.id,
    connectionName: connection.displayName || connection.name || connection.email || connection.id,
    copilotToken: connection.providerSpecificData?.copilotToken,
    providerSpecificData: {
      ...(connection.providerSpecificData || {}),
      connectionProxyEnabled: proxy.connectionProxyEnabled,
      connectionProxyUrl: proxy.connectionProxyUrl,
      connectionNoProxy: proxy.connectionNoProxy,
      connectionProxyPoolId: proxy.proxyPoolId || null,
      vercelRelayUrl: proxy.vercelRelayUrl || "",
      strictProxy: proxy.strictProxy === true,
    },
  };
  credentials = await checkAndRefreshToken(provider, credentials);
  if ((provider === "antigravity" || provider === "gemini-cli") && !credentials.projectId) {
    const projectId = await getProjectIdForConnection(connection.id, credentials.accessToken, provider);
    if (projectId) {
      credentials.projectId = projectId;
      await updateProviderCredentials(connection.id, { projectId });
    }
  }
  if (modelInfo.contextMarker) credentials.contextMarker = modelInfo.contextMarker;
  signal.throwIfAborted();

  // Invoke the shared provider executor with this key. The public chat route's
  // account fallback could otherwise report another key's response as its result.
  const result = await handleChatCore({
    body: {
      model: `${provider}/${model}`,
      messages: [{ role: "user", content: testType === "essay" ? ESSAY_PROMPT : PING_PROMPT }],
      max_tokens: testType === "essay" ? 2048 : 1024,
      stream: true,
      stream_options: { include_usage: true },
    },
    modelInfo: { provider, model },
    credentials,
    connectionId: connection.id,
    providerThinking: settings.providerThinking?.[provider] || null,
    providerOverrides: settings.providerOverrides?.[provider] || null,
    sourceFormatOverride: "openai",
    signal,
    log,
    onCredentialsRefreshed: (newCredentials) => updateProviderCredentials(connection.id, {
      ...newCredentials,
      existingProviderSpecificData: credentials.providerSpecificData,
    }),
  });
  if (!result.response) {
    return { ok: false, error: result.error || "Provider returned no response", status: result.status || null, latencyMs: Date.now() - startTime };
  }
  const verdict = await consumeProbeStream(result.response, { startTime, signal });
  return { ...verdict, status: result.response.status, latencyMs: Date.now() - startTime };
}

/** Test every active upstream key once; average only successful measurements. */
export async function runModelTest(requestedModel, testType, requestSignal) {
  const { model: modelName, contextMarker } = stripModelContextMarker(requestedModel);
  const resolved = await getModelInfo(modelName);
  const timeoutMs = TEST_TIMEOUT_MS[testType];
  if (!resolved.provider) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = requestSignal ? AbortSignal.any([requestSignal, timeout]) : timeout;
    const result = await pingModelByKind(requestedModel, "llm", undefined, { testType, signal });
    return { ...aggregateModelTestResults([withAbortError(result, signal, requestSignal, timeoutMs)]), testType };
  }

  const { provider } = resolved;
  let connections = await getProviderConnections({ provider, isActive: true });
  connections = connections.filter((connection) => connection.isActive !== false);
  if (connections.length === 0 && FREE_PROVIDERS[provider]?.noAuth) {
    const credentials = await getProviderCredentials(provider, new Set(), resolved.model);
    if (credentials && !credentials.allRateLimited) {
      connections = [{ ...credentials, id: credentials.connectionId || credentials.id || "noauth", provider }];
    }
  }
  if (connections.length === 0) {
    const result = { ok: false, error: `No active credentials for provider: ${provider}`, status: 404, latencyMs: 0 };
    return { ...aggregateModelTestResults([result]), testType };
  }

  const direct = isAnthropicCompatibleProvider(provider) || isOpenAICompatibleProvider(provider) || provider === "treg";
  const settings = direct ? {} : await getSettings();
  const results = [];
  // Measure sequentially to avoid competing requests distorting throughput.
  for (const connection of connections) {
    const start = Date.now();
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = requestSignal ? AbortSignal.any([requestSignal, timeout]) : timeout;
    let result;
    try {
      signal.throwIfAborted();
      result = direct
        ? await probeConnectionModel(connection, resolved.model, { testType, signal })
        : await probeProviderConnection(connection, { ...resolved, contextMarker }, testType, signal, settings);
    } catch (error) {
      result = {
        ok: false,
        error: requestSignal?.aborted ? "Test canceled" : signal.aborted ? `Timed out after ${timeoutMs}ms` : error.message || String(error),
        latencyMs: Date.now() - start,
        status: error.statusCode || null,
      };
    }
    results.push({
      ...withAbortError(result, signal, requestSignal, timeoutMs),
      connectionId: connection.id,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
    });
    if (requestSignal?.aborted) break;
  }
  return { ...aggregateModelTestResults(results), testType };
}
