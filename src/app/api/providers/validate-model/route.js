import { NextResponse } from "next/server";
import { getProviderNodeById } from "@/models";
import {
  isOpenAICompatibleProvider,
  isAnthropicCompatibleProvider,
  isCustomEmbeddingProvider,
  AI_PROVIDERS,
} from "@/shared/constants/providers";
import { PROVIDERS, resolveOllamaLocalHost, resolveXiaomiTokenplanBaseUrl } from "open-sse/config/providers.js";
import { probeModelEndpoint } from "@/lib/modelProbe/probe";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { normalizeProviderId } from "@/lib/providerNormalization";

// /api/providers/validate answers "is this key accepted"; it never touches the model
// the user typed. This answers the other half: "does that model actually answer on
// this key". Kept as its own route so the key check stays a cheap /models GET and the
// model check — one real completion — only runs when a model was actually given.

/**
 * Where to send the probe for a not-yet-saved credential.
 * Returns null when the provider speaks a transport the probe cannot shape
 * (gemini, cursor protobuf, kiro EventStream, tts/stt configs, …) — the caller
 * reports that as "unsupported", not as a failure.
 */
async function resolveProbeTarget(provider, providerSpecificData) {
  // Compatible nodes carry a user-supplied base URL rather than a registry transport.
  if (isOpenAICompatibleProvider(provider) || isCustomEmbeddingProvider(provider)) {
    const node = await getProviderNodeById(provider);
    return node?.baseUrl ? { baseUrl: node.baseUrl, format: "openai" } : null;
  }
  if (isAnthropicCompatibleProvider(provider)) {
    const node = await getProviderNodeById(provider);
    return node?.baseUrl ? { baseUrl: node.baseUrl, format: "claude" } : null;
  }

  // Ollama's native /api/chat is not OpenAI-shaped, but it also serves an
  // OpenAI-compatible endpoint on the same host — probe that one.
  if (provider === "ollama-local") {
    return { baseUrl: `${resolveOllamaLocalHost({ providerSpecificData })}/v1`, format: "openai" };
  }
  if (provider === "xiaomi-tokenplan") {
    return { baseUrl: resolveXiaomiTokenplanBaseUrl({ providerSpecificData }), format: "openai" };
  }

  const cfg = PROVIDERS[provider];
  if (!cfg?.baseUrl) return null;
  if (cfg.format !== "openai" && cfg.format !== "claude") return null;
  return {
    baseUrl: cfg.baseUrl,
    format: cfg.format,
    headers: cfg.headers,
    authHeader: cfg.authHeader,
  };
}

// POST /api/providers/validate-model - Send one completion with the chosen model
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const provider = normalizeProviderId(body.provider);
    const { apiKey, providerSpecificData } = body;
    const model = typeof body.model === "string" ? body.model.trim() : "";

    if (!provider || !model) {
      return NextResponse.json({ error: "Provider and model required" }, { status: 400 });
    }

    const isNoAuth = AI_PROVIDERS[provider]?.noAuth === true || PROVIDERS[provider]?.noAuth === true;
    if (!apiKey && provider !== "ollama-local" && !isNoAuth) {
      return NextResponse.json({ error: "API key required" }, { status: 400 });
    }

    const target = await resolveProbeTarget(provider, providerSpecificData);
    if (!target) {
      return NextResponse.json({
        ok: false,
        supported: false,
        model,
        error: "Model check is not available for this provider",
      });
    }

    const proxy = await resolveConnectionProxyConfig(providerSpecificData || {});
    const result = await probeModelEndpoint({
      ...target,
      apiKey,
      model,
      proxy,
      signal: AbortSignal.timeout(25000),
    });

    return NextResponse.json({
      ok: result.ok,
      supported: true,
      model,
      error: result.ok ? null : (result.error || "Model did not respond"),
      note: result.note || null,
      status: result.status ?? null,
      latencyMs: result.latencyMs ?? null,
    });
  } catch (error) {
    console.log("Error validating model:", error);
    return NextResponse.json({ error: "Model validation failed" }, { status: 500 });
  }
}
