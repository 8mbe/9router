import { NextResponse } from "next/server";
import { getAutoComboHealth, resetAutoComboHealth } from "open-sse/services/autoComboHealth.js";
import { resolveAutoCombo, inspectAutoComboMembers } from "@/sse/services/autoCombo";
import { getSettings, getModelAliases, getCombos } from "@/lib/localDb";
import { getComboModels } from "@/sse/services/model";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/auto-combo
 *   → recorded provider/model outcomes.
 * GET /api/auto-combo?model=gpt-5.6-sol
 *   → plus the combo that name would resolve to right now, without sending a
 *     request. Useful for checking which providers a bare name reaches.
 */
export async function GET(request) {
  try {
    const requested = new URL(request.url).searchParams.get("model")?.trim();
    const model = requested ? stripModelContextMarker(requested).model : null;
    const settings = await getSettings();
    const combos = await getCombos();
    const configured = new Set(combos
      .filter((combo) => !combo.kind || combo.kind === "llm")
      .flatMap((combo) => combo.models || [])
      .filter((member) => typeof member === "string" && member.includes("/")));
    for (const entry of Object.values(settings.capacityAdapter || {})) {
      const models = Array.isArray(entry) ? entry.map((item) => item?.model || item) : entry?.models || [];
      for (const member of models) if (typeof member === "string" && member.includes("/")) configured.add(member);
    }
    const byMember = new Map(getAutoComboHealth().map((entry) => [entry.member.toLowerCase(), entry]));
    for (const entry of await inspectAutoComboMembers([...configured], settings)) {
      byMember.set(entry.member.toLowerCase(), entry);
    }
    const health = [...byMember.values()];
    const config = { enabled: settings.autoComboEnabled !== false, strategy: "fallback" };
    if (!model) return NextResponse.json({ health, ...config }, { headers: { "Cache-Control": "no-store" } });

    const combo = await getComboModels(model);
    const aliases = combo ? {} : await getModelAliases();
    const alias = aliases?.[model];
    const aliasMember = typeof alias === "string" && alias.includes("/")
      ? alias
      : alias?.provider && alias?.model ? `${alias.provider}/${alias.model}` : null;
    let source = null;
    let resolved = null;
    let strategy = config.strategy;
    if (combo || aliasMember) {
      source = combo ? "combo" : "alias";
      const models = combo || [aliasMember];
      resolved = {
        models,
        benched: [],
        matchTier: null,
        members: await inspectMembers(models, settings),
      };
      if (combo) strategy = settings.comboStrategies?.[model]?.fallbackStrategy || settings.comboStrategy || "fallback";
    } else {
      resolved = await resolveAutoCombo(model, settings);
      if (resolved) source = "automatic";
    }
    return NextResponse.json({
      model,
      resolved,
      source,
      ...config,
      strategy,
      health,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.log("Error reading auto-combo state:", error);
    return NextResponse.json({ error: "Failed to read combo status" }, { status: 500 });
  }
}

async function inspectMembers(models, settings) {
  const routes = await inspectAutoComboMembers(models.filter((member) => member.includes("/")), settings);
  const byMember = new Map(routes.map((entry) => [entry.member, entry]));
  return models.map((member) => byMember.get(member) || {
    member, modelId: member, providerId: null, status: "untested",
  });
}

/**
 * DELETE /api/auto-combo            → clear recorded outcomes.
 * DELETE /api/auto-combo?member=x/y → clear one provider/model outcome.
 */
export async function DELETE(request) {
  try {
    const member = new URL(request.url).searchParams.get("member");
    resetAutoComboHealth(member || undefined);
    return NextResponse.json({ ok: true, cleared: member || "all" });
  } catch (error) {
    console.log("Error clearing auto-combo state:", error);
    return NextResponse.json({ error: "Failed to clear combo status" }, { status: 500 });
  }
}
