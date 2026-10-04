// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/analytics → { window, distribution, trends, costPerRun,
// signups, unsupportedClaimRate, truncated }. Delegates to queryAnalytics
// (same helper the /admin/analytics page reads directly).
// Window: ?window=7d|30d|90d (default 7d) or ?window=custom&from=ISO&to=ISO
// (span capped at 90 days; invalid → 400 via parseAdminWindow inside the
// helper). Verdict distribution + runs/day + cost/day trends over the
// window; spend labeled estimated (sum(trace_events.cost_usd) — COST_TABLE
// metering, not provider billing). NULL-workspace legacy rows EXCLUDED on
// the platform path; the workspace path goes through the user client (RLS)
// + scopedQuery, whose `.in('workspace_id', workspaceIds)` predicate never
// matches NULL rows. Server-side caps (traces 10000, decisions 5000,
// signups 5000) set `truncated: true` when they bind (T3-I2/T4-I4
// follow-up). Matrix: platform full; workspace-tier member+ read scoped to
// own workspaces; viewers get NONE at the requireAdmin gate.
// Errors use the admin-only envelope { error, code } via toEnvelope().
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  requireAdminFromSupabase,
  toEnvelope,
} from "@/lib/admin";
import { createQueryDeps } from "@/lib/admin-queries/shared";
import { queryAnalytics } from "@/lib/admin-queries/analytics";

export async function GET(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdminFromSupabase();
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }

  try {
    const params = new URL(request.url).searchParams;
    const deps = await createQueryDeps(admin);
    const dto = await queryAnalytics(deps, {
      window: params.get("window"),
      from: params.get("from"),
      to: params.get("to"),
    });
    return NextResponse.json(dto);
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}
