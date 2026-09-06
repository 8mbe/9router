import { NextResponse } from "next/server";
import { getProviderConnectionById, getProviderConnections, getCustomModels } from "@/models";
import { getModelProbes, clearModelProbes } from "@/lib/db/repos/modelProbesRepo.js";
import { invalidateProbeHints } from "@/lib/modelProbe/routingHints";
import { getProviderAlias, isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";
import {
  startProbeJob, getJob, cancelJob, serializeJob, findLatestJobForProvider,
  clampConcurrency, MAX_CONCURRENCY, DEFAULT_CONCURRENCY,
} from "@/lib/modelProbe/jobs";

export const dynamic = "force-dynamic";

// A run is one live completion per (key, model) pair. Without a ceiling, a page with
// 10 keys and 200 models would fire 2000 billable requests from a single click.
const MAX_PAIRS = 600;

function storageAlias(providerId) {
  const compatible = isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId);
  return compatible ? providerId : getProviderAlias(providerId);
}

async function resolveProvider(id) {
  const connection = await getProviderConnectionById(id);
  if (!connection) return null;
  const providerId = connection.provider;
  return { providerId, providerAlias: storageAlias(providerId) };
}

/**
 * GET /api/providers/[id]/model-probe
 *   ?jobId=… → that job's live progress
 *   otherwise → stored verdicts for this provider, plus any run still in flight
 */
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const resolved = await resolveProvider(id);
    if (!resolved) return NextResponse.json({ error: "Connection not found" }, { status: 404 });

    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get("jobId");
    if (jobId) {
      const job = getJob(jobId);
      if (!job) return NextResponse.json({ error: "Job not found or expired" }, { status: 404 });
      return NextResponse.json({ job: serializeJob(job) });
    }

    const connections = await getProviderConnections({ provider: resolved.providerId });
    const probes = await getModelProbes({
      providerAlias: resolved.providerAlias,
      connectionIds: connections.map((c) => c.id),
    });

    return NextResponse.json({
      providerId: resolved.providerId,
      providerAlias: resolved.providerAlias,
      probes,
      job: serializeJob(findLatestJobForProvider(resolved.providerId)),
      maxConcurrency: MAX_CONCURRENCY,
      defaultConcurrency: DEFAULT_CONCURRENCY,
    });
  } catch (error) {
    console.log("Error reading model probes:", error);
    return NextResponse.json({ error: "Failed to read model probes" }, { status: 500 });
  }
}

/**
 * POST /api/providers/[id]/model-probe
 * Body: { models?: string[], connectionIds?: string[], concurrency?: number }
 * Starts a background run and returns immediately with the job.
 */
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const resolved = await resolveProvider(id);
    if (!resolved) return NextResponse.json({ error: "Connection not found" }, { status: 404 });

    const body = await request.json().catch(() => ({}));
    const { providerId, providerAlias } = resolved;

    const allConnections = await getProviderConnections({ provider: providerId });
    const requested = Array.isArray(body.connectionIds) && body.connectionIds.length > 0
      ? new Set(body.connectionIds)
      : null;
    // Inactive connections are excluded unless named explicitly: a disabled key is
    // one the user has already decided not to route through.
    const connections = allConnections.filter((c) => (requested ? requested.has(c.id) : c.isActive !== false));
    if (connections.length === 0) {
      return NextResponse.json({ error: "No connections to test for this provider" }, { status: 400 });
    }

    let modelIds;
    if (Array.isArray(body.models) && body.models.length > 0) {
      modelIds = body.models.map((m) => (typeof m === "string" ? m : m?.id)).filter(Boolean);
    } else {
      const custom = await getCustomModels();
      modelIds = custom
        .filter((m) => m?.providerAlias === providerAlias && (m.type || "llm") === "llm" && m.id)
        .map((m) => m.id);
    }
    modelIds = [...new Set(modelIds)];
    if (modelIds.length === 0) {
      return NextResponse.json({ error: "No models to test for this provider" }, { status: 400 });
    }

    const pairCount = modelIds.length * connections.length;
    if (pairCount > MAX_PAIRS) {
      return NextResponse.json(
        { error: `Too many combinations (${pairCount}). Limit is ${MAX_PAIRS} — narrow the model or key selection.` },
        { status: 400 }
      );
    }

    const job = startProbeJob({
      providerId,
      providerAlias,
      connectionIds: connections.map((c) => c.id),
      models: modelIds,
      concurrency: clampConcurrency(body.concurrency ?? DEFAULT_CONCURRENCY),
    });

    return NextResponse.json({ job: serializeJob(job) });
  } catch (error) {
    console.log("Error starting model probe:", error);
    return NextResponse.json({ error: "Failed to start model probe" }, { status: 500 });
  }
}

/**
 * DELETE /api/providers/[id]/model-probe
 *   ?jobId=…   → cancel a running job
 *   ?modelId=… → forget stored verdicts for that model
 *   otherwise  → forget every stored verdict for this provider
 */
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const resolved = await resolveProvider(id);
    if (!resolved) return NextResponse.json({ error: "Connection not found" }, { status: 404 });

    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get("jobId");
    if (jobId) {
      return NextResponse.json({ cancelled: cancelJob(jobId) });
    }

    const removed = await clearModelProbes({
      providerAlias: resolved.providerAlias,
      modelId: searchParams.get("modelId") || undefined,
    });
    // Routing reads verdicts through a cache; drop it so the next request does not
    // keep steering on results the user just deleted.
    invalidateProbeHints();
    return NextResponse.json({ removed });
  } catch (error) {
    console.log("Error clearing model probes:", error);
    return NextResponse.json({ error: "Failed to clear model probes" }, { status: 500 });
  }
}
