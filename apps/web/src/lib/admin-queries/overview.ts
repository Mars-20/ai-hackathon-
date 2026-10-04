import "server-only";
import { scopedAdminQuery } from "@/lib/admin";
import type { AdminQueryDeps } from "./shared";

interface TraceWindowRow {
  workspace_id: string | null;
  cost_usd: number | string | null;
  created_at: string;
}

interface DecisionWindowRow {
  verdict: string | null;
  created_at: string;
}

export interface TrendPoint {
  day: string;
  runs: number;
  cost: number;
}

export interface OverviewKpis {
  users: number;
  activeWorkspaces: number;
  startups: number;
  runs7d: number;
  rejectRate: number | null;
  spend: { value: number; estimated: true };
}

export interface OverviewResult {
  kpis: OverviewKpis;
  trends: TrendPoint[];
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
    // Drop malformed timestamps: buildTrends calls toISOString(), which
    // throws RangeError on Invalid Date and would 500 the whole page.
    if (Number.isNaN(Date.parse(created))) continue;
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
    costByDay.set(day, (costByDay.get(day) ?? 0) + toCostNumber(row.cost_usd));
  }
  return days.map((day) => ({
    day,
    runs: runsByDay.get(day) ?? 0,
    cost: Math.round(((costByDay.get(day) ?? 0) + Number.EPSILON) * 100) / 100,
  }));
}

function summarize(
  traces: TraceWindowRow[],
  decisions: DecisionWindowRow[],
  userCount: number,
  startupCount: number,
  sinceIso: string,
): OverviewResult {
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

/**
 * GET /api/admin/overview logic: { kpis, trends } over a trailing window
 * (days clamped to 1..90, default 7). Platform path reads via service-role
 * with NULL-workspace legacy rows EXCLUDED (`.not("workspace_id", "is",
 * null)` — never attributed to any workspace). Workspace-tier path reads
 * through the user client (RLS) + scopedQuery, whose appended
 * `.in("workspace_id", ...)` predicate excludes NULL rows the same way.
 * spend = sum(trace_events.cost_usd) labeled { value, estimated: true }
 * ("estimated — COST_TABLE metering, not provider billing").
 */
export async function queryOverview(
  deps: AdminQueryDeps,
  days: number,
): Promise<OverviewResult> {
  const windowDays =
    Number.isFinite(days) && days >= 1 ? Math.min(days, 90) : 7;
  const since = new Date(
    Date.now() - windowDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { admin, userClient, service } = deps;

  if (admin.tier === "platform") {
    // One concurrent round: the four reads are independent.
    const [profilesRes, startupsRes, tracesRes, decisionsRes] =
      await Promise.all([
        service.from("profiles").select("user_id", { count: "exact", head: true }),
        // NULL workspace_id rows EXCLUDED — never attributed.
        service
          .from("startups")
          .select("id", { count: "exact", head: true })
          .not("workspace_id", "is", null),
        // NULL workspace_id rows EXCLUDED from every aggregation.
        service
          .from("trace_events")
          .select("workspace_id,cost_usd,created_at")
          .gte("created_at", since)
          .not("workspace_id", "is", null)
          .order("created_at", { ascending: true })
          .limit(10000),
        service
          .from("decisions")
          .select("verdict,created_at")
          .gte("created_at", since)
          .not("workspace_id", "is", null)
          .limit(5000),
      ]);
    const userCount =
      typeof profilesRes.count === "number" ? profilesRes.count : 0;
    const startupCount =
      typeof startupsRes.count === "number" ? startupsRes.count : 0;
    if (tracesRes.error) throw tracesRes.error;
    const traces = asTraceRows(tracesRes.data);
    if (decisionsRes.error) throw decisionsRes.error;
    const decisions = asDecisionRows(decisionsRes.data);

    return summarize(traces, decisions, userCount, startupCount, since);
  }

  // Workspace tier: user client (RLS) + scopedQuery — the scoping
  // predicate `.in('workspace_id', workspaceIds)` is appended inside
  // scopedQuery (single DB round-trip; NULL rows never match the IN list).
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

  return summarize(traces, decisions, userCount, startupCount, since);
}
