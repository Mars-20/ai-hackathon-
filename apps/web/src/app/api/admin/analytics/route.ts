// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/analytics → { window, distribution, trends, costPerRun,
// signups, unsupportedClaimRate, truncated } (Task 5 analytics module).
// Window: ?window=7d|30d|90d (default 7d) or ?window=custom&from=ISO&to=ISO
// (span capped at 90 days; invalid → 400 via parseAdminWindow).
// Verdict distribution + runs/day + cost/day trends over the window; spend
// labeled estimated (sum(trace_events.cost_usd) — COST_TABLE metering, not
// provider billing). NULL-workspace legacy rows EXCLUDED on the platform
// path; the workspace path goes through the user client (RLS) +
// scopedQuery, whose `.in('workspace_id', workspaceIds)` predicate never
// matches NULL rows. Server-side caps (traces 10000, decisions 5000,
// signups 5000) set `truncated: true` when they bind (T3-I2/T4-I4
// follow-up). Matrix: platform full; workspace-tier member+ read scoped to
// own workspaces; viewers get NONE at the requireAdmin gate.
// Errors use the admin-only envelope { error, code } via toEnvelope().
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  parseAdminWindow,
  requireAdminFromSupabase,
  scopedAdminQuery,
  toEnvelope,
} from "@/lib/admin";
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from "@/lib/supabase/server";

const TRACE_CAP = 10000;
const DECISION_CAP = 5000;
const SIGNUP_CAP = 5000;

interface TraceRow {
  workspace_id: string | null;
  cost_usd: number | string | null;
  created_at: string;
  event_type: string;
  payload: unknown;
}

interface DecisionRow {
  verdict: string | null;
  created_at: string;
}

interface TrendPoint {
  day: string;
  runs: number;
  cost: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toCostNumber(value: number | string | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function asTraceRows(value: unknown): TraceRow[] {
  if (!Array.isArray(value)) return [];
  const out: TraceRow[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (typeof item["created_at"] !== "string") continue;
    const cost = item["cost_usd"];
    const ws = item["workspace_id"];
    out.push({
      workspace_id: typeof ws === "string" ? ws : null,
      cost_usd:
        typeof cost === "number" || typeof cost === "string" ? cost : null,
      created_at: item["created_at"] as string,
      event_type:
        typeof item["event_type"] === "string"
          ? (item["event_type"] as string)
          : "",
      payload: item["payload"] ?? null,
    });
  }
  return out;
}

function asDecisionRows(value: unknown): DecisionRow[] {
  if (!Array.isArray(value)) return [];
  const out: DecisionRow[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (typeof item["created_at"] !== "string") continue;
    out.push({
      verdict: typeof item["verdict"] === "string" ? item["verdict"] : null,
      created_at: item["created_at"] as string,
    });
  }
  return out;
}

/** Bucket rows by UTC day across the whole window (zero-filled). */
function buildTrends(rows: TraceRow[], fromIso: string, toIso: string): TrendPoint[] {
  const points: TrendPoint[] = [];
  const cursor = new Date(fromIso);
  cursor.setUTCHours(0, 0, 0, 0);
  const end = new Date(toIso);
  end.setUTCHours(0, 0, 0, 0);
  const runsByDay = new Map<string, number>();
  const costByDay = new Map<string, number>();
  for (const row of rows) {
    const day = new Date(row.created_at).toISOString().slice(0, 10);
    runsByDay.set(day, (runsByDay.get(day) ?? 0) + 1);
    costByDay.set(
      day,
      (costByDay.get(day) ?? 0) + toCostNumber(row.cost_usd),
    );
  }
  while (cursor <= end) {
    const day = cursor.toISOString().slice(0, 10);
    points.push({
      day,
      runs: runsByDay.get(day) ?? 0,
      cost:
        Math.round(((costByDay.get(day) ?? 0) + Number.EPSILON) * 100) / 100,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return points;
}

export async function GET(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdminFromSupabase();
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }

  let window;
  try {
    window = parseAdminWindow(new URL(request.url).searchParams);
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }

  try {
    let traces: TraceRow[];
    let decisions: DecisionRow[];
    let signups: number;
    let truncated = false;

    if (admin.tier === "platform") {
      const service = createServiceRoleClient();
      // NULL workspace_id rows EXCLUDED — never attributed.
      const tracesRes = await service
        .from("trace_events")
        .select("workspace_id,cost_usd,created_at,event_type,payload")
        .gte("created_at", window.from)
        .lte("created_at", window.to)
        .not("workspace_id", "is", null)
        .order("created_at", { ascending: true })
        .limit(TRACE_CAP);
      if (tracesRes.error) throw tracesRes.error;
      traces = asTraceRows(tracesRes.data);
      if (traces.length >= TRACE_CAP) truncated = true;

      const decisionsRes = await service
        .from("decisions")
        .select("verdict,created_at")
        .gte("created_at", window.from)
        .lte("created_at", window.to)
        .not("workspace_id", "is", null)
        .limit(DECISION_CAP);
      if (decisionsRes.error) throw decisionsRes.error;
      decisions = asDecisionRows(decisionsRes.data);
      if (decisions.length >= DECISION_CAP) truncated = true;

      const signupsRes = await service
        .from("profiles")
        .select("user_id", { count: "exact", head: true })
        .gte("created_at", window.from)
        .lte("created_at", window.to);
      if (signupsRes.error) throw signupsRes.error;
      signups = typeof signupsRes.count === "number" ? signupsRes.count : 0;
    } else {
      // Workspace tier: user client (RLS) + scopedQuery — the scoping
      // predicate `.in('workspace_id', workspaceIds)` is appended inside
      // scopedQuery (single DB round-trip; NULL rows never match the IN
      // list).
      const userClient = await createServerSupabaseClient();
      const traceRowsUnknown: unknown = await scopedAdminQuery(
        userClient,
        "trace_events",
        admin.workspaceIds,
        (q) =>
          q
            .select("workspace_id,cost_usd,created_at,event_type,payload")
            .gte("created_at", window.from)
            .lte("created_at", window.to)
            .order("created_at", { ascending: true })
            .limit(TRACE_CAP),
      );
      traces = asTraceRows(traceRowsUnknown);
      if (traces.length >= TRACE_CAP) truncated = true;

      const decisionRowsUnknown: unknown = await scopedAdminQuery(
        userClient,
        "decisions",
        admin.workspaceIds,
        (q) =>
          q
            .select("verdict,created_at")
            .gte("created_at", window.from)
            .lte("created_at", window.to)
            .limit(DECISION_CAP),
      );
      decisions = asDecisionRows(decisionRowsUnknown);
      if (decisions.length >= DECISION_CAP) truncated = true;

      const memberRowsUnknown: unknown = await scopedAdminQuery(
        userClient,
        "workspace_members",
        admin.workspaceIds,
        (q) =>
          q
            .select("user_id,joined_at")
            .gte("joined_at", window.from)
            .limit(SIGNUP_CAP),
      );
      const memberRows: unknown[] = Array.isArray(memberRowsUnknown)
        ? memberRowsUnknown
        : [];
      if (memberRows.length >= SIGNUP_CAP) truncated = true;
      signups = memberRows.filter(
        (r) =>
          isRecord(r) &&
          typeof r["joined_at"] === "string" &&
          (r["joined_at"] as string) <= window.to,
      ).length;
    }

    const distribution = { go: 0, iterate: 0, stop: 0, test_more: 0 };
    for (const d of decisions) {
      if (d.verdict === "go") distribution.go += 1;
      else if (d.verdict === "iterate") distribution.iterate += 1;
      else if (d.verdict === "stop") distribution.stop += 1;
      else if (d.verdict === "test_more") distribution.test_more += 1;
    }

    let spendRaw = 0;
    for (const row of traces) spendRaw += toCostNumber(row.cost_usd);
    const spend = Math.round((spendRaw + Number.EPSILON) * 100) / 100;

    let verificationTotal = 0;
    let verificationUnsupported = 0;
    for (const row of traces) {
      if (row.event_type !== "verification") continue;
      verificationTotal += 1;
      if (!isRecord(row.payload)) continue;
      const unsupported = row.payload["unsupported_count"];
      const claims = row.payload["unsupported_claims"];
      if (
        (typeof unsupported === "number" && unsupported > 0) ||
        (Array.isArray(claims) && claims.length > 0)
      ) {
        verificationUnsupported += 1;
      }
    }

    return NextResponse.json({
      window: {
        preset: window.preset,
        from: window.from,
        to: window.to,
        days: window.days,
      },
      distribution: { ...distribution, total: decisions.length },
      trends: buildTrends(traces, window.from, window.to),
      // Estimated — COST_TABLE metering, not provider billing.
      costPerRun:
        traces.length > 0
          ? {
              value:
                Math.round((spend / traces.length + Number.EPSILON) * 100) /
                100,
              estimated: true,
            }
          : null,
      signups,
      unsupportedClaimRate:
        verificationTotal > 0
          ? Math.round(
              (verificationUnsupported / verificationTotal + Number.EPSILON) *
                1000,
            ) / 1000
          : null,
      truncated,
    });
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}
