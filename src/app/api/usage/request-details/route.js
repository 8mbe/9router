import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getRequestDetails } from "@/lib/usageDb";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";
import { isLocalRequest } from "@/dashboardGuard";

const PAYLOAD_KEYS = ["request", "providerRequest", "providerResponse", "response"];

/**
 * Conversation payloads (prompts, tool calls, provider responses) are the point of
 * this endpoint — the dashboard's request-details drawer is unusable without them.
 * They are also the most sensitive thing in the DB, so only hand them back to a
 * caller we can actually attribute: a valid dashboard JWT, or a loopback request
 * from the host itself. The dangerous case the old blanket redaction guarded
 * against was `requireLogin: false` + remote access, where dashboardGuard lets any
 * caller through; that case still gets metadata only.
 */
async function canReadPayloads(request) {
  // Fail closed: any error reading the session degrades to redacted metadata
  // rather than failing the request, so the drawer still renders.
  try {
    const token = (await cookies()).get("auth_token")?.value;
    if (await verifyDashboardAuthToken(token)) return true;
  } catch {
    // No cookie store (called outside a request scope) — fall through.
  }
  try {
    return isLocalRequest(request);
  } catch {
    return false;
  }
}

/**
 * GET /api/usage/request-details
 * Query parameters: page, pageSize (1-100), provider, model, connectionId, status, startDate, endDate
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);

    const pageRaw = parseInt(searchParams.get("page"));
    const page = Number.isNaN(pageRaw) ? 1 : pageRaw;
    const pageSizeRaw = parseInt(searchParams.get("pageSize"));
    const pageSize = Number.isNaN(pageSizeRaw) ? 20 : pageSizeRaw;
    const provider = searchParams.get("provider");
    const model = searchParams.get("model");
    const connectionId = searchParams.get("connectionId");
    const status = searchParams.get("status");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");

    if (page < 1) {
      return NextResponse.json(
        { error: "Page must be >= 1" },
        { status: 400 }
      );
    }

    if (pageSize < 1 || pageSize > 100) {
      return NextResponse.json(
        { error: "PageSize must be between 1 and 100" },
        { status: 400 }
      );
    }

    const filter = {
      page,
      pageSize
    };

    if (provider) filter.provider = provider;
    if (model) filter.model = model;
    if (connectionId) filter.connectionId = connectionId;
    if (status) filter.status = status;
    if (startDate) filter.startDate = startDate;
    if (endDate) filter.endDate = endDate;

    const result = await getRequestDetails(filter);

    if (await canReadPayloads(request)) {
      return NextResponse.json({ ...result, redacted: false });
    }

    // Unattributable caller (requireLogin disabled + remote): metadata only.
    const redactedDetails = (result.details || []).map((d) => {
      const redacted = { ...d };
      for (const key of PAYLOAD_KEYS) {
        if (redacted[key] !== undefined) {
          redacted[key] = { redacted: true };
        }
      }
      return redacted;
    });

    return NextResponse.json({ ...result, details: redactedDetails, redacted: true });
  } catch (error) {
    console.error("[API] Failed to get request details:", error);
    return NextResponse.json(
      { error: "Failed to fetch request details" },
      { status: 500 }
    );
  }
}
