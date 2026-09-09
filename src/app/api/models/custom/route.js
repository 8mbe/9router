import { NextResponse } from "next/server";
import { getCustomModels, addCustomModel, addCustomModels, deleteCustomModel } from "@/models";
import { CAPACITY_META } from "@/shared/constants/models";
import { normalizeContextLength } from "@/lib/modelProbe/contextLength";

export const dynamic = "force-dynamic";

// Whitelist capability keys to boolean values — ignore anything else
function sanitizeCaps(caps) {
  if (!caps || typeof caps !== "object") return null;
  const clean = {};
  for (const key of Object.keys(CAPACITY_META)) {
    if (typeof caps[key] === "boolean") clean[key] = caps[key];
  }
  return Object.keys(clean).length ? clean : null;
}

// GET /api/models/custom - List all custom models
export async function GET() {
  try {
    const models = await getCustomModels();
    return NextResponse.json({ models });
  } catch (error) {
    console.log("Error fetching custom models:", error);
    return NextResponse.json({ error: "Failed to fetch custom models" }, { status: 500 });
  }
}

// Absent contextLength = leave any stored window alone; explicit null = clear it.
// An unparseable value is treated as "clear" rather than silently stored.
function normalizeEntry(raw) {
  const { providerAlias, id, type, name, caps, contextLength } = raw || {};
  if (!providerAlias || !id) return null;
  const cleanCaps = sanitizeCaps(caps);
  const hasContext = contextLength !== undefined;
  return {
    providerAlias,
    id,
    type: type || "llm",
    name,
    ...(cleanCaps ? { caps: cleanCaps } : {}),
    ...(hasContext ? { contextLength: normalizeContextLength(contextLength) } : {}),
  };
}

// POST /api/models/custom - Add one custom model, or a batch via `models: [...]`
//
// The batch form exists because importing an aggregator's model list used to fire one
// request (and one transaction) per model. Both forms return the full resulting list
// so the caller does not need a follow-up GET to refresh its state.
export async function POST(request) {
  try {
    const body = await request.json();
    const batch = Array.isArray(body?.models) ? body.models : null;

    if (batch) {
      const entries = batch.map(normalizeEntry).filter(Boolean);
      if (entries.length === 0) {
        return NextResponse.json({ error: "models[] must contain entries with providerAlias and id" }, { status: 400 });
      }
      const added = await addCustomModels(entries);
      return NextResponse.json({ success: true, added, models: await getCustomModels() });
    }

    const entry = normalizeEntry(body);
    if (!entry) {
      return NextResponse.json({ error: "providerAlias and id required" }, { status: 400 });
    }
    const added = await addCustomModel(entry);
    return NextResponse.json({ success: true, added, models: await getCustomModels() });
  } catch (error) {
    console.log("Error adding custom model:", error);
    return NextResponse.json({ error: "Failed to add custom model" }, { status: 500 });
  }
}

// DELETE /api/models/custom?providerAlias=xxx&id=yyy&type=zzz
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const providerAlias = searchParams.get("providerAlias");
    const id = searchParams.get("id");
    const type = searchParams.get("type") || "llm";
    if (!providerAlias || !id) {
      return NextResponse.json({ error: "providerAlias and id required" }, { status: 400 });
    }
    await deleteCustomModel({ providerAlias, id, type });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting custom model:", error);
    return NextResponse.json({ error: "Failed to delete custom model" }, { status: 500 });
  }
}
