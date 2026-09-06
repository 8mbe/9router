import { NextResponse } from "next/server";
import { getApiKeys, createApiKey } from "@/lib/localDb";
import { getApiKeySpend } from "@/lib/db/index.js";
import { getConsistentMachineId } from "@/shared/utils/machineId";

export const dynamic = "force-dynamic";

// GET /api/keys - List API keys
// ?spend=1 also returns per-key money spent (opt-in: it scans the usage rollups)
export async function GET(request) {
  try {
    const keys = await getApiKeys();

    const wantSpend = new URL(request.url).searchParams.get("spend") === "1";
    if (!wantSpend) return NextResponse.json({ keys });

    const spend = await getApiKeySpend();
    const spendById = {};
    for (const s of spend.keys) spendById[s.id] = s;

    return NextResponse.json({
      keys: keys.map((k) => ({
        ...k,
        spend: spendById[k.id]?.spend || null,
        lastUsed: spendById[k.id]?.lastUsed || null,
      })),
      spend: {
        totals: spend.totals,
        unattributed: spend.unattributed,
        deleted: spend.deleted,
      },
    });
  } catch (error) {
    console.log("Error fetching keys:", error);
    return NextResponse.json({ error: "Failed to fetch keys" }, { status: 500 });
  }
}

// POST /api/keys - Create new API key
export async function POST(request) {
  try {
    const body = await request.json();
    const { name } = body;

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    // Always get machineId from server
    const machineId = await getConsistentMachineId();
    const apiKey = await createApiKey(name, machineId);

    return NextResponse.json({
      key: apiKey.key,
      name: apiKey.name,
      id: apiKey.id,
      machineId: apiKey.machineId,
    }, { status: 201 });
  } catch (error) {
    console.log("Error creating key:", error);
    return NextResponse.json({ error: "Failed to create key" }, { status: 500 });
  }
}
