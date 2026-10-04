import "server-only";
import {
  escapePostgrest,
  getPagination,
  parseSearchQuery,
  scopedAdminQuery,
} from "@/lib/admin";
import type { AdminQueryDeps } from "./shared";

const SORT_ALLOWLIST = ["name", "created_at", "plan"] as const;
type SortCol = (typeof SORT_ALLOWLIST)[number];

const VALID_PLANS = ["free", "pro", "team"] as const;
const VALID_STATUS = ["active", "suspended"] as const;

export interface WorkspacesListInput {
  page: string | number | null;
  limit: string | number | null;
  sort: string | null;
  order: string | null;
  q: string | null;
  plan: string | null;
  status: string | null;
}

export interface WorkspaceUsageRow {
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

export interface WorkspacesListResult {
  workspaces: WorkspaceUsageRow[];
  total: number;
  pages: number;
  page: number;
  limit: number;
}

export interface WorkspaceMemberRow {
  user_id: string;
  role: string;
  joined_at: string | null;
  email: string;
}

export interface WorkspaceDetailResult {
  workspace: {
    id: string;
    name: string;
    slug: string;
    plan: string;
    status: string;
    created_at: string;
  };
  members: WorkspaceMemberRow[];
  metrics: {
    members: number;
    startups: number;
    evidence: number;
    runs: number;
    spend: { value: number; estimated: true };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Structurally AdminError (name/status/code/message), like the errors
// thrown in packages/admin/scopedQuery.ts — normalize identically through
// toEnvelope() in routes and runAdminQuery, reproducing the exact
// { error, code } bodies the routes returned inline.
function structuralAdminError(
  status: number,
  code: string,
  message: string,
): Error & { status: number; code: string } {
  const err = new Error(message) as Error & { status: number; code: string };
  err.name = "AdminError";
  err.status = status;
  err.code = code;
  return err;
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
      created_at:
        typeof item["created_at"] === "string" ? item["created_at"] : "",
    });
  }
  return out;
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

function roundSpend(raw: number): number {
  return Math.round((raw + Number.EPSILON) * 100) / 100;
}

/**
 * GET /api/admin/workspaces logic: filtered page + batched per-workspace
 * usage totals (members, startups, runs, evidence, estimated spend).
 * Platform tier reads all rows via service-role. Workspace tier discovers
 * scope through the user client (RLS) + scopedQuery, then reads via
 * service-role FILTERED to the in-scope workspace ids only (same documented
 * exception as users: the workspaces table is keyed by id, so scopedQuery
 * cannot express the read; the in-scope id filter guarantees zero
 * cross-rows). Throws structural 400 on junk plan/status filters.
 */
export async function queryWorkspacesList(
  deps: AdminQueryDeps,
  input: WorkspacesListInput,
): Promise<WorkspacesListResult> {
  const { page, limit, offset } = getPagination({
    page: input.page,
    limit: input.limit,
  });
  const rawSort = input.sort ?? "created_at";
  const sort: SortCol = (SORT_ALLOWLIST as readonly string[]).includes(rawSort)
    ? (rawSort as SortCol)
    : "created_at";
  const ascending = input.order === "asc";
  const search = parseSearchQuery(input.q);

  const plan: string | null =
    input.plan === null || input.plan === "" ? null : input.plan;
  if (plan !== null && !(VALID_PLANS as readonly string[]).includes(plan)) {
    throw structuralAdminError(400, "BAD_REQUEST", "Invalid plan filter");
  }
  const status: string | null =
    input.status === null || input.status === "" ? null : input.status;
  if (
    status !== null &&
    !(VALID_STATUS as readonly string[]).includes(status)
  ) {
    throw structuralAdminError(400, "BAD_REQUEST", "Invalid status filter");
  }

  const { admin, userClient, service } = deps;

  // Scope: platform sees all; workspace tier is restricted to its own ids
  // (discovered via the user client + scopedQuery below).
  let scopeIds: string[] | null = null;
  if (admin.tier !== "platform") {
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
      return { workspaces: [], total: 0, pages: 0, page, limit };
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
    const [membersRes, startupsRes, evidenceRes, tracesRes] =
      await Promise.all([
        service
          .from("workspace_members")
          .select("workspace_id")
          .in("workspace_id", pageIds)
          .limit(5000),
        service
          .from("startups")
          .select("workspace_id")
          .in("workspace_id", pageIds)
          .limit(5000),
        service
          .from("evidence")
          .select("workspace_id")
          .in("workspace_id", pageIds)
          .limit(5000),
        service
          .from("trace_events")
          .select("workspace_id,cost_usd")
          .in("workspace_id", pageIds)
          .limit(10000),
      ]);
    if (membersRes.error) throw membersRes.error;
    if (startupsRes.error) throw startupsRes.error;
    if (evidenceRes.error) throw evidenceRes.error;
    if (tracesRes.error) throw tracesRes.error;
    const memberRows: unknown[] = Array.isArray(membersRes.data)
      ? membersRes.data
      : [];
    const startupRows: unknown[] = Array.isArray(startupsRes.data)
      ? startupsRes.data
      : [];
    const evidenceRows: unknown[] = Array.isArray(evidenceRes.data)
      ? evidenceRes.data
      : [];
    const traceRows: unknown[] = Array.isArray(tracesRes.data)
      ? tracesRes.data
      : [];
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

  const workspaces: WorkspaceUsageRow[] = rows.map((w) => {
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
      spend: { value: roundSpend(spendRaw), estimated: true },
    };
  });

  return {
    workspaces,
    total,
    pages: limit > 0 ? Math.ceil(total / limit) : 0,
    page,
    limit,
  };
}

/**
 * GET /api/admin/workspaces/[id] logic: workspace facts + member roster
 * (with profile emails) + usage metrics. Platform tier full; workspace tier
 * read-only for GET when the id is in scope. Throws structural 403 when a
 * workspace-tier caller asks for an out-of-scope id, and structural 404
 * when the row is missing — both normalize through toEnvelope() to the
 * exact { error, code } bodies the route returned inline.
 */
export async function queryWorkspaceDetail(
  deps: AdminQueryDeps,
  id: string,
): Promise<WorkspaceDetailResult> {
  const { admin, service } = deps;

  if (admin.tier !== "platform" && !admin.workspaceIds.includes(id)) {
    // Existence-oracle note (accepted): 403 here distinguishes "exists, out
    // of scope" from the 404 below. IDs are unguessable UUIDs and callers
    // are admins — documented rather than flattened.
    throw structuralAdminError(403, "FORBIDDEN", "Workspace out of scope");
  }

  const { data: workspace, error: wsError } = await service
    .from("workspaces")
    .select("id,name,slug,plan,status,created_at")
    .eq("id", id)
    .maybeSingle();
  if (wsError) throw wsError;
  if (!isRecord(workspace)) {
    throw structuralAdminError(404, "NOT_FOUND", "Workspace not found");
  }

  // Members + profile emails, and basic metrics — all strictly filtered
  // to this workspace (`.in('workspace_id', [id])` / `.eq`), so a
  // workspace-tier caller never sees cross-rows. Profile emails are
  // fetched with `.in("user_id", memberIds)` (chunked) — never a
  // cross-tenant full-table read filtered in JS.
  const [membersRes, startupsRes, evidenceRes, tracesRes] = await Promise.all([
    service
      .from("workspace_members")
      .select("user_id,role,joined_at")
      .eq("workspace_id", id)
      .limit(1000),
    service
      .from("startups")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", id),
    service
      .from("evidence")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", id),
    service
      .from("trace_events")
      .select("cost_usd")
      .eq("workspace_id", id)
      .limit(10000),
  ]);
  if (membersRes.error) throw membersRes.error;
  if (startupsRes.error) throw startupsRes.error;
  if (evidenceRes.error) throw evidenceRes.error;
  if (tracesRes.error) throw tracesRes.error;

  const memberRows: unknown[] = Array.isArray(membersRes.data)
    ? membersRes.data
    : [];
  const memberIds = memberRows
    .filter(isRecord)
    .map((m) => m["user_id"])
    .filter((v): v is string => typeof v === "string");
  const profileRows: unknown[] = [];
  const CHUNK_SIZE = 200;
  for (let i = 0; i < memberIds.length; i += CHUNK_SIZE) {
    const chunk = memberIds.slice(i, i + CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const chunkRes = await service
      .from("profiles")
      .select("user_id,email")
      .in("user_id", chunk);
    if (chunkRes.error) throw chunkRes.error;
    if (Array.isArray(chunkRes.data)) profileRows.push(...chunkRes.data);
  }
  const emailByUser = new Map<string, string>();
  for (const p of profileRows) {
    if (!isRecord(p)) continue;
    if (typeof p["user_id"] !== "string") continue;
    emailByUser.set(
      p["user_id"] as string,
      typeof p["email"] === "string" ? (p["email"] as string) : "",
    );
  }
  const members: WorkspaceMemberRow[] = memberRows.filter(isRecord).map((m) => ({
    user_id: typeof m["user_id"] === "string" ? (m["user_id"] as string) : "",
    role: typeof m["role"] === "string" ? (m["role"] as string) : "",
    joined_at:
      typeof m["joined_at"] === "string" ? (m["joined_at"] as string) : null,
    email: emailByUser.get(
      typeof m["user_id"] === "string" ? (m["user_id"] as string) : "",
    ) ?? "",
  }));

  const traceRows: unknown[] = Array.isArray(tracesRes.data)
    ? tracesRes.data
    : [];
  let spendRaw = 0;
  for (const row of traceRows) {
    if (!isRecord(row)) continue;
    spendRaw += toCostNumber(row["cost_usd"]);
  }

  return {
    workspace: {
      id: workspace["id"] as string,
      name: typeof workspace["name"] === "string" ? workspace["name"] : "",
      slug: typeof workspace["slug"] === "string" ? workspace["slug"] : "",
      plan: typeof workspace["plan"] === "string" ? workspace["plan"] : "free",
      status:
        typeof workspace["status"] === "string" ? workspace["status"] : "active",
      created_at:
        typeof workspace["created_at"] === "string"
          ? workspace["created_at"]
          : "",
    },
    members,
    metrics: {
      members: members.length,
      startups:
        typeof startupsRes.count === "number" ? startupsRes.count : 0,
      evidence: typeof evidenceRes.count === "number" ? evidenceRes.count : 0,
      runs: traceRows.length,
      // Estimated — COST_TABLE metering, not provider billing.
      spend: { value: roundSpend(spendRaw), estimated: true },
    },
  };
}
