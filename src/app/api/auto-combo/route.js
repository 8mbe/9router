import { NextResponse } from "next/server";
import { getAutoComboHealth, resetAutoComboHealth } from "open-sse/services/autoComboHealth.js";
import { resolveAutoCombo } from "@/sse/services/autoCombo";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/auto-combo
 *   → which provider/model pairs auto-combo has benched, and why.
 * GET /api/auto-combo?model=gpt-5.6-sol
 *   → plus the combo that name would resolve to right now, without sending a
 *     request. Useful for checking which providers a bare name reaches.
 */
export async function GET(request) {
  try {
    const model = new URL(request.url).searchParams.get("model");
    const health = getAutoComboHealth();
    if (!model) return NextResponse.json({ health }, { headers: { "Cache-Control": "no-store" } });

    const resolved = await resolveAutoCombo(model);
    return NextResponse.json({
      model,
      resolved: resolved
        ? { models: resolved.models, benched: resolved.benched, matchTier: resolved.matchTier }
        : null,
      health,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.log("Error reading auto-combo state:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * DELETE /api/auto-combo            → un-bench everything.
 * DELETE /api/auto-combo?member=x/y → un-bench one provider/model pair.
 */
export async function DELETE(request) {
  try {
    const member = new URL(request.url).searchParams.get("member");
    resetAutoComboHealth(member || undefined);
    return NextResponse.json({ ok: true, cleared: member || "all" });
  } catch (error) {
    console.log("Error clearing auto-combo state:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
