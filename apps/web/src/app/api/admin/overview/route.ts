// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/overview → { kpis, trends } (spec §§2-4). Delegates to
// queryOverview (same helper the /admin page reads directly).
// Every workspace-tier read goes through the user client (RLS) + scopedQuery,
// which always appends `.in('workspace_id', workspaceIds)`; NULL-workspace
// legacy rows are EXCLUDED via `.not('workspace_id', 'is', null)` on the
// platform path (the scoped `.in('workspace_id', ...)` predicate excludes
// them on the workspace path — never attributed to any workspace).
// spend = sum(trace_events.cost_usd) labeled { value, estimated: true }
// ("estimated — COST_TABLE metering, not provider billing").
// trends bucket by day — SQL equivalent `date_trunc('day', created_at)`.
// Errors use the admin-only envelope { error, code } via toEnvelope().
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  requireAdminFromSupabase,
  toEnvelope,
} from "@/lib/admin";
import { createQueryDeps } from "@/lib/admin-queries/shared";
import { queryOverview } from "@/lib/admin-queries/overview";

export async function GET(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdminFromSupabase();
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }

  try {
    const deps = await createQueryDeps(admin);
    const url = new URL(request.url);
    const rawDays = Number.parseInt(url.searchParams.get("days") ?? "7", 10);
    const dto = await queryOverview(deps, rawDays);
    return NextResponse.json(dto);
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}
