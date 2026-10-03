// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/workspaces → { workspaces, total, pages, page, limit }
// (spec §§2-3,7). Filters: plan (free/pro/team), status (active/suspended),
// q (prefix/contains search on name/slug via the canonical escaper),
// sort allowlist (name/created_at/plan). Per-workspace usage totals:
// members, startups, runs, evidence, estimated spend
// (spend = sum(trace_events.cost_usd) labeled { value, estimated: true }).
// Platform tier reads all rows via service-role. Workspace tier discovers
// scope through the user client (RLS) + scopedQuery — the scoping predicate
// `.in('workspace_id', workspaceIds)` is appended inside scopedQuery — then
// reads via service-role FILTERED to the in-scope workspace ids only
// (same documented exception as /api/admin/users: the workspaces table is
// keyed by id, not workspace_id, so scopedQuery cannot express the read;
// the in-scope id filter guarantees zero cross-rows). NULL-workspace rows
// are N/A here (workspaces always carry their own id).
// Errors use the admin-only envelope { error, code } via toEnvelope().
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  escapePostgrest,
  getPagination,
  parseSearchQuery,
  requireAdminFromSupabase,
  scopedAdminQuery,
  toEnvelope,
} from "@/lib/admin";
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from "@/lib/supabase/server";

const SORT_ALLOWLIST = ["name", "created_at", "plan"] as const;
type SortCol = (typeof SORT_ALLOWLIST)[number];

const VALID_PLANS = ["free", "pro", "team"] as const;
const VALID_STATUS = ["active", "suspended"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  created_at: string;
}

function asWorkspaceRows(value: unknown): WorkspaceRow[] {
  if (!Array.isArray(value)) return [];
  const out: WorkspaceRow[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (typeof item["id"] !== "string") continue;
    out.push({
      id: item["id"] as string,
      name: typeof item["name"] === "string" ? item["name"] : "",
      slug: typeof item["slug"] === "string" ? item["slug"] : "",
      plan: typeof item["plan"] === "string" ? item["plan"] : "free",
      status: typeof item["status"] === "string" ? item["status"] : "active",
      created_at: typeof item["created_at"] === "string" ? item["created_at"] : "",
    });
  }
  return out;
}

interface WorkspaceUsage {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  created_at: string;
  memberCount: number;
  startupCount: number;
  runs: number;
  evidenceCount: number;
  spend: { value: number; estimated: true };
}

function toCostNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function countBy<T>(rows: T[], key: (row: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const k = key(row);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

function workspaceIdOf(row: unknown): string | null {
  if (!isRecord(row)) return null;
  const ws = row["workspace_id"];
  return typeof ws === "string" ? ws : null;
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
    const { page, limit, offset } = getPagination(url.searchParams);
    const rawSort = url.searchParams.get("sort") ?? "created_at";
    const sort: SortCol = (SORT_ALLOWLIST as readonly string[]).includes(rawSort)
      ? (rawSort as SortCol)
      : "created_at";
    const ascending = url.searchParams.get("order") === "asc";
    const search = parseSearchQuery(url.searchParams.get("q"));

    const rawPlan = url.searchParams.get("plan");
    const plan: string | null = rawPlan === null || rawPlan === "" ? null : rawPlan;
    if (plan !== null && !(VALID_PLANS as readonly string[]).includes(plan)) {
      return NextResponse.json(
        { error: "Invalid plan filter", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }
    const rawStatus = url.searchParams.get("status");
    const status: string | null = rawStatus === null || rawStatus === "" ? null : rawStatus;
    if (status !== null && !(VALID_STATUS as readonly string[]).includes(status)) {
      return NextResponse.json(
        { error: "Invalid status filter", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }

    const service = createServiceRoleClient();

    // Scope: platform sees all; workspace tier is restricted to its own ids
    // (discovered via the user client + scopedQuery below).
    let scopeIds: string[] | null = null;
    if (admin.tier !== "platform") {
      const userClient = await createServerSupabaseClient();
      // Scoping predicate `.in('workspace_id', workspaceIds)` appended
      // inside scopedQuery (single DB round-trip).
      const scopeUnknown: unknown = await scopedAdminQuery(
        userClient,
        "workspace_members",
        admin.workspaceIds,
        (q) => q.select("workspace_id"),
      );
      const ids = Array.isArray(scopeUnknown)
        ? scopeUnknown
            .map(workspaceIdOf)
            .filter((v): v is string => typeof v === "string" && v.length > 0)
        : [];
      scopeIds = [...new Set(ids)];
      if (scopeIds.length === 0) {
        return NextResponse.json({ workspaces: [], total: 0, pages: 0, page, limit });
      }
    }

    // Main page query (service-role; workspace tier pre-filtered to scope).
    let query = service
      .from("workspaces")
      .select("id,name,slug,plan,status,created_at", { count: "exact" })
      .order(sort, { ascending });
    if (plan !== null) query = query.eq("plan", plan);
    if (status !== null) query = query.eq("status", status);
    if (search !== null) {
      const e = escapePostgrest(search);
      query = query.or(`name.ilike.%${e}%,slug.ilike.%${e}%`);
    }
    if (scopeIds !== null) query = query.in("id", scopeIds);
    query = query.range(offset, offset + limit - 1);
    const { data, count, error } = await query;
    if (error) throw error;
    const rows = asWorkspaceRows(data);
    const total = typeof count === "number" ? count : rows.length;
    const pageIds = rows.map((w) => w.id);

    // Batched usage totals (service-role, strictly filtered to the page's
    // own workspace ids — `.in('workspace_id', pageIds)` — zero cross-rows).
    let memberCounts = new Map<string, number>();
    let startupCounts = new Map<string, number>();
    let evidenceCounts = new Map<string, number>();
    let runCounts = new Map<string, number>();
    const spendByWs = new Map<string, number>();
    if (pageIds.length > 0) {
      const [membersRes, startupsRes, evidenceRes, tracesRes] = await Promise.all([
        service.from("workspace_members").select("workspace_id").in('workspace_id', pageIds).limit(5000),
        service.from("startups").select("workspace_id").in('workspace_id', pageIds).limit(5000),
        service.from("evidence").select("workspace_id").in('workspace_id', pageIds).limit(5000),
        service.from("trace_events").select("workspace_id,cost_usd").in('workspace_id', pageIds).limit(10000),
      ]);
      if (membersRes.error) throw membersRes.error;
      if (startupsRes.error) throw startupsRes.error;
      if (evidenceRes.error) throw evidenceRes.error;
      if (tracesRes.error) throw tracesRes.error;
      const memberRows: unknown[] = Array.isArray(membersRes.data) ? membersRes.data : [];
      const startupRows: unknown[] = Array.isArray(startupsRes.data) ? startupsRes.data : [];
      const evidenceRows: unknown[] = Array.isArray(evidenceRes.data) ? evidenceRes.data : [];
      const traceRows: unknown[] = Array.isArray(tracesRes.data) ? tracesRes.data : [];
      memberCounts = countBy(memberRows, (r) => workspaceIdOf(r) ?? "");
      startupCounts = countBy(startupRows, (r) => workspaceIdOf(r) ?? "");
      evidenceCounts = countBy(evidenceRows, (r) => workspaceIdOf(r) ?? "");
      runCounts = countBy(traceRows, (r) => workspaceIdOf(r) ?? "");
      for (const row of traceRows) {
        if (!isRecord(row)) continue;
        const ws = workspaceIdOf(row);
        if (ws === null) continue;
        spendByWs.set(ws, (spendByWs.get(ws) ?? 0) + toCostNumber(row["cost_usd"]));
      }
    }

    const workspaces: WorkspaceUsage[] = rows.map((w) => {
      const spendRaw = spendByWs.get(w.id) ?? 0;
      return {
        id: w.id,
        name: w.name,
        slug: w.slug,
        plan: w.plan,
        status: w.status,
        created_at: w.created_at,
        memberCount: memberCounts.get(w.id) ?? 0,
        startupCount: startupCounts.get(w.id) ?? 0,
        runs: runCounts.get(w.id) ?? 0,
        evidenceCount: evidenceCounts.get(w.id) ?? 0,
        // Estimated — COST_TABLE metering, not provider billing.
        spend: {
          value: Math.round((spendRaw + Number.EPSILON) * 100) / 100,
          estimated: true,
        },
      };
    });

    return NextResponse.json({
      workspaces,
      total,
      pages: limit > 0 ? Math.ceil(total / limit) : 0,
      page,
      limit,
    });
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}
