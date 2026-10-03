// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/overview → { kpis, trends } (spec §§2-4).
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
  scopedAdminQuery,
  toEnvelope,
} from "@/lib/admin";
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from "@/lib/supabase/server";

interface TraceWindowRow {
  workspace_id: string | null;
  cost_usd: number | string | null;
  created_at: string;
}

interface DecisionWindowRow {
  verdict: string | null;
  created_at: string;
}

interface TrendPoint {
  day: string;
  runs: number;
  cost: number;
}

interface OverviewKpis {
  users: number;
  activeWorkspaces: number;
  startups: number;
  runs7d: number;
  rejectRate: number | null;
  spend: { value: number; estimated: true };
}

function toCostNumber(value: number | string | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asTraceRows(value: unknown): TraceWindowRow[] {
  if (!Array.isArray(value)) return [];
  const out: TraceWindowRow[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const ws = item["workspace_id"];
    const cost = item["cost_usd"];
    const created = item["created_at"];
    if (typeof created !== "string") continue;
    out.push({
      workspace_id: typeof ws === "string" ? ws : null,
      cost_usd:
        typeof cost === "number" || typeof cost === "string" ? cost : null,
      created_at: created,
    });
  }
  return out;
}

function asDecisionRows(value: unknown): DecisionWindowRow[] {
  if (!Array.isArray(value)) return [];
  const out: DecisionWindowRow[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const verdict = item["verdict"];
    const created = item["created_at"];
    if (typeof created !== "string") continue;
    out.push({
      verdict: typeof verdict === "string" ? verdict : null,
      created_at: created,
    });
  }
  return out;
}

/** Bucket rows by UTC day (SQL: date_trunc('day', created_at)). */
function buildTrends(rows: TraceWindowRow[], sinceIso: string): TrendPoint[] {
  const since = new Date(sinceIso);
  const days: string[] = [];
  const cursor = new Date(
    Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate()),
  );
  const today = new Date();
  const end = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  while (cursor <= end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const runsByDay = new Map<string, number>();
  const costByDay = new Map<string, number>();
  for (const row of rows) {
    // date_trunc('day', created_at) equivalent: UTC calendar day.
    const day = new Date(row.created_at).toISOString().slice(0, 10);
    runsByDay.set(day, (runsByDay.get(day) ?? 0) + 1);
    costByDay.set(
      day,
      (costByDay.get(day) ?? 0) + toCostNumber(row.cost_usd),
    );
  }
  return days.map((day) => ({
    day,
    runs: runsByDay.get(day) ?? 0,
    cost:
      Math.round(((costByDay.get(day) ?? 0) + Number.EPSILON) * 100) / 100,
  }));
}

function summarize(
  traces: TraceWindowRow[],
  decisions: DecisionWindowRow[],
  userCount: number,
  startupCount: number,
  sinceIso: string,
): { kpis: OverviewKpis; trends: TrendPoint[] } {
  const activeIds = new Set<string>();
  let spendRaw = 0;
  for (const row of traces) {
    if (typeof row.workspace_id === "string" && row.workspace_id.length > 0) {
      activeIds.add(row.workspace_id);
    }
    spendRaw += toCostNumber(row.cost_usd);
  }
  const totalDecisions = decisions.length;
  const rejected = decisions.filter((d) => d.verdict === "stop").length;
  const kpis: OverviewKpis = {
    users: userCount,
    // active workspaces defined as >=1 agent run in trailing 7d.
    activeWorkspaces: activeIds.size,
    startups: startupCount,
    runs7d: traces.length,
    rejectRate:
      totalDecisions > 0
        ? Math.round((rejected / totalDecisions + Number.EPSILON) * 1000) / 1000
        : null,
    // spend is sum(cost_usd) — LABELED estimated, not provider billing.
    spend: {
      value: Math.round((spendRaw + Number.EPSILON) * 100) / 100,
      estimated: true,
    },
  };
  return { kpis, trends: buildTrends(traces, sinceIso) };
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
    const rawDays = Number.parseInt(url.searchParams.get("days") ?? "7", 10);
    const days =
      Number.isFinite(rawDays) && rawDays >= 1 ? Math.min(rawDays, 90) : 7;
    const since = new Date(
      Date.now() - days * 24 * 60 * 60 * 1000,
    ).toISOString();

    if (admin.tier === "platform") {
      const service = createServiceRoleClient();

      const profilesRes = await service
        .from("profiles")
        .select("user_id", { count: "exact", head: true });
      const userCount =
        typeof profilesRes.count === "number" ? profilesRes.count : 0;

      // NULL workspace_id rows EXCLUDED — never attributed.
      const startupsRes = await service
        .from("startups")
        .select("id", { count: "exact", head: true })
        .not("workspace_id", "is", null);
      const startupCount =
        typeof startupsRes.count === "number" ? startupsRes.count : 0;

      // NULL workspace_id rows EXCLUDED from every aggregation.
      const tracesRes = await service
        .from("trace_events")
        .select("workspace_id,cost_usd,created_at")
        .gte("created_at", since)
        .not("workspace_id", "is", null)
        .order("created_at", { ascending: true })
        .limit(10000);
      if (tracesRes.error) throw tracesRes.error;
      const traces = asTraceRows(tracesRes.data);

      const decisionsRes = await service
        .from("decisions")
        .select("verdict,created_at")
        .gte("created_at", since)
        .not("workspace_id", "is", null)
        .limit(5000);
      if (decisionsRes.error) throw decisionsRes.error;
      const decisions = asDecisionRows(decisionsRes.data);

      return NextResponse.json(summarize(traces, decisions, userCount, startupCount, since));
    }

    // Workspace tier: user client (RLS) + scopedQuery — the scoping
    // predicate `.in('workspace_id', workspaceIds)` is appended inside
    // scopedQuery (single DB round-trip; NULL rows never match the IN list).
    const userClient = await createServerSupabaseClient();

    const memberRowsUnknown: unknown = await scopedAdminQuery(
      userClient,
      "workspace_members",
      admin.workspaceIds,
      (q) => q.select("user_id"),
    );
    const memberRows: Array<{ user_id: string }> = Array.isArray(
      memberRowsUnknown,
    )
      ? (memberRowsUnknown as Array<unknown>).filter(
          (r): r is { user_id: string } =>
            isRecord(r) && typeof r["user_id"] === "string",
        )
      : [];
    const userCount = new Set(memberRows.map((r) => r.user_id)).size;

    const startupRowsUnknown: unknown = await scopedAdminQuery(
      userClient,
      "startups",
      admin.workspaceIds,
      (q) => q.select("id"),
    );
    const startupCount = Array.isArray(startupRowsUnknown)
      ? startupRowsUnknown.length
      : 0;

    const traceRowsUnknown: unknown = await scopedAdminQuery(
      userClient,
      "trace_events",
      admin.workspaceIds,
      (q) =>
        q
          .select("workspace_id,cost_usd,created_at")
          .gte("created_at", since)
          .order("created_at", { ascending: true })
          .limit(10000),
    );
    const traces = asTraceRows(traceRowsUnknown);

    const decisionRowsUnknown: unknown = await scopedAdminQuery(
      userClient,
      "decisions",
      admin.workspaceIds,
      (q) => q.select("verdict,created_at").gte("created_at", since).limit(5000),
    );
    const decisions = asDecisionRows(decisionRowsUnknown);

    return NextResponse.json(
      summarize(traces, decisions, userCount, startupCount, since),
    );
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}
