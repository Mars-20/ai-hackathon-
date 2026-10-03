// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/content/details?startup_id= → full detail graph
// { startup, assumptions, evidence, decisions, traces } (spec §§2-3,7).
// Both tiers read through scopedQuery: platform via the service-role client
// filtered to the single startup id (+ `.not('workspace_id', 'is', null)`
// on child reads so NULL-workspace rows never mix in); workspace tier via
// the user client (RLS) + scopedQuery — the scoping predicate
// `.in('workspace_id', workspaceIds)` is appended inside scopedQuery, so an
// out-of-scope id yields 404 (no existence leak).
// Errors use the admin-only envelope { error, code } via toEnvelope().
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  requireAdminFromSupabase,
  scopedAdminQuery,
  toEnvelope,
} from "@/lib/admin";
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from "@/lib/supabase/server";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

export async function GET(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdminFromSupabase();
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }

  try {
    const url = new URL(request.url);
    const startupId = url.searchParams.get("startup_id");
    if (typeof startupId !== "string" || startupId.length === 0) {
      return NextResponse.json(
        { error: "startup_id is required", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }

    if (admin.tier === "platform") {
      const service = createServiceRoleClient();
      const [startupRes, assumptionsRes, evidenceRes, decisionsRes, tracesRes] =
        await Promise.all([
          service.from("startups").select("*").eq("id", startupId).maybeSingle(),
          service.from("evidence").select("*").eq("startup_id", startupId).not("workspace_id", "is", null).order("collected_at", { ascending: false }).limit(1000),
          service.from("assumptions").select("*").eq("startup_id", startupId).not("workspace_id", "is", null).order("created_at", { ascending: false }).limit(1000),
          service.from("decisions").select("*").eq("startup_id", startupId).not("workspace_id", "is", null).order("created_at", { ascending: false }).limit(500),
          service.from("trace_events").select("*").eq("startup_id", startupId).not("workspace_id", "is", null).order("created_at", { ascending: false }).limit(1000),
        ]);
      if (startupRes.error) throw startupRes.error;
      if (assumptionsRes.error) throw assumptionsRes.error;
      if (evidenceRes.error) throw evidenceRes.error;
      if (decisionsRes.error) throw decisionsRes.error;
      if (tracesRes.error) throw tracesRes.error;
      if (!isRecord(startupRes.data)) {
        return NextResponse.json(
          { error: "Startup not found", code: "NOT_FOUND" },
          { status: 404 },
        );
      }
      return NextResponse.json({
        startup: startupRes.data,
        assumptions: asRows(assumptionsRes.data),
        evidence: asRows(evidenceRes.data),
        decisions: asRows(decisionsRes.data),
        traces: asRows(tracesRes.data),
      });
    }

    // Workspace tier: user client (RLS) + scopedQuery — the scoping
    // predicate `.in('workspace_id', workspaceIds)` is appended inside
    // scopedQuery (single DB round-trip per table; NULL rows never match).
    const userClient = await createServerSupabaseClient();
    const [startupUnknown, assumptionsUnknown, evidenceUnknown, decisionsUnknown, tracesUnknown] =
      await Promise.all([
        scopedAdminQuery(userClient, "startups", admin.workspaceIds, (q) =>
          q.select("*").eq("id", startupId),
        ),
        scopedAdminQuery(userClient, "assumptions", admin.workspaceIds, (q) =>
          q.select("*").eq("startup_id", startupId).order("created_at", { ascending: false }).limit(1000),
        ),
        scopedAdminQuery(userClient, "evidence", admin.workspaceIds, (q) =>
          q.select("*").eq("startup_id", startupId).order("collected_at", { ascending: false }).limit(1000),
        ),
        scopedAdminQuery(userClient, "decisions", admin.workspaceIds, (q) =>
          q.select("*").eq("startup_id", startupId).order("created_at", { ascending: false }).limit(500),
        ),
        scopedAdminQuery(userClient, "trace_events", admin.workspaceIds, (q) =>
          q.select("*").eq("startup_id", startupId).order("created_at", { ascending: false }).limit(1000),
        ),
      ]);
    const startupRows = asRows(startupUnknown);
    // `.eq("id", ...)` returns at most one row; out-of-scope → zero rows.
    const startup: Record<string, unknown> | null =
      startupRows.length > 0 ? (startupRows[0] as Record<string, unknown>) : null;
    if (startup === null) {
      return NextResponse.json(
        { error: "Startup not found", code: "NOT_FOUND" },
        { status: 404 },
      );
    }
    return NextResponse.json({
      startup,
      assumptions: asRows(assumptionsUnknown),
      evidence: asRows(evidenceUnknown),
      decisions: asRows(decisionsUnknown),
      traces: asRows(tracesUnknown),
    });
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}
