import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/lib/localDb";
import { getProviderModels, PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";
import { CLAUDE_CODE } from "open-sse/config/claudeCodeConstants.js";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { pingModelByKind } from "@/app/api/models/test/ping";
import { probeConnectionModel } from "@/lib/modelProbe/probe";

/**
 * POST /api/providers/[id]/test-models
 * id = connectionId — resolves provider + model list. Custom Anthropic LLM tests
 * use this exact connection and its mode; other requests use the internal endpoint.
 */
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const providerId = connection.provider;
    const isAnthropicCompatible = isAnthropicCompatibleProvider(providerId);
    const isCompatible = isOpenAICompatibleProvider(providerId) || isAnthropicCompatible;
    const alias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;

    let models = getProviderModels(alias);

    const baseUrl = `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`;
    const useClaudeCode = isAnthropicCompatible
      && connection.providerSpecificData?.executionMode === CLAUDE_CODE.executionMode;
    const testModel = (model) => {
      const kind = model.kind || model.type || "llm";
      return isAnthropicCompatible && kind === "llm"
        ? probeConnectionModel(connection, model.id, { signal: request.signal })
        : pingModelByKind(`${alias}/${model.id}`, kind, baseUrl);
    };

    // Compatible providers: fetch live model list
    if (isCompatible && models.length === 0) {
      try {
        const cookie = request.headers.get("cookie");
        const modelsRes = await fetch(`${baseUrl}/api/providers/${id}/models`, {
          ...(cookie ? { headers: { cookie } } : {}),
        });
        if (modelsRes.ok) {
          const data = await modelsRes.json();
          models = (data.models || []).map((m) => {
            const kind = m.kind || m.type || "llm";
            return {
              id: m.id || m.name,
              name: m.name || m.id,
              kind: kind === "model" ? "llm" : kind,
            };
          });
        }
      } catch { /* fallback to empty */ }
    }

    if (models.length === 0) {
      return NextResponse.json({ error: "No models configured for this provider" }, { status: 400 });
    }

    // Warm up with first model to trigger token refresh (if needed) before parallel calls.
    // This prevents race condition where multiple requests concurrently refresh the same token.
    const [first, ...rest] = models;
    const firstResult = await testModel(first);
    const results = [{ modelId: first.id, name: first.name || first.id, ...firstResult }];

    if (rest.length > 0) {
      const testWithResult = async (model) => ({
        modelId: model.id,
        name: model.name || model.id,
        ...await testModel(model),
      });
      if (useClaudeCode) {
        // Each model starts a Claude Code process, so a long model list must not
        // exhaust the server by launching all of its runtimes at once.
        for (let index = 0; index < rest.length; index += CLAUDE_CODE.modelProbeConcurrency) {
          const batch = rest.slice(index, index + CLAUDE_CODE.modelProbeConcurrency);
          results.push(...await Promise.all(batch.map(testWithResult)));
        }
      } else {
        results.push(...await Promise.all(rest.map(testWithResult)));
      }
    }

    return NextResponse.json({ provider: providerId, connectionId: id, results });
  } catch (error) {
    console.log("Error testing models:", error);
    return NextResponse.json({ error: "Test failed" }, { status: 500 });
  }
}
