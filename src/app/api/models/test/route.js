import { NextResponse } from "next/server";
import { pingModelByKind } from "./ping";
import { isAnthropicCompatibleProvider } from "@/shared/constants/providers";

async function probeCustomAnthropicModel(model, signal) {
  const { getModelInfo } = await import("@/sse/services/model");
  const resolved = await getModelInfo(model);
  if (!isAnthropicCompatibleProvider(resolved.provider)) return null;

  const start = Date.now();
  const { getProviderCredentials } = await import("@/sse/services/auth");
  const credentials = await getProviderCredentials(resolved.provider, new Set(), resolved.model);
  if (!credentials || credentials.allRateLimited) {
    return {
      ok: false,
      error: credentials?.allRateLimited
        ? credentials.lastError || "All provider credentials are temporarily unavailable"
        : `No active credentials for provider: ${resolved.provider}`,
      latencyMs: Date.now() - start,
      status: credentials?.allRateLimited ? 503 : 404,
    };
  }

  const { getProviderConnectionById } = await import("@/lib/localDb");
  const connection = await getProviderConnectionById(credentials.connectionId);
  if (!connection) {
    return { ok: false, error: "Connection not found", latencyMs: Date.now() - start, status: 404 };
  }

  // Probe the chosen key directly so its Claude Code preference is honored and
  // a failure cannot be hidden by the completion endpoint's account fallback.
  const { probeConnectionModel } = await import("@/lib/modelProbe/probe");
  return probeConnectionModel(connection, resolved.model, { signal });
}

// POST /api/models/test - Ping a single model using its configured execution mode.
export async function POST(request) {
  try {
    const { model, kind } = await request.json();
    if (!model) return NextResponse.json({ error: "Model required" }, { status: 400 });
    const modelKind = kind || "llm";
    const probe = modelKind === "llm" ? await probeCustomAnthropicModel(model, request.signal) : null;
    const result = probe || await pingModelByKind(model, modelKind);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
