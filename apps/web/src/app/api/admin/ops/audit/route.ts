// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/ops/audit → { entries, total, pages, page, limit }
// (Task 5 ops module). Actor/action exact-match filters (?actor=uuid,
// ?action=...), newest-first, paginated via getPagination (defaults page
// 20 / max 100). Only safe audit_log columns are selected
// (id, actor, action, target, reason, diff, workspace_id, result,
// created_at) — no stack traces or server internals are ever returned;
// failures normalize through toEnvelope() (no stacks leak).
// Scoping: platform tier reads all rows via the service-role client;
// workspace tier requires admin/owner (S7-strict, spec §7 "audit read-only
// for admin/owner"): workspace-tier members (role viewer OR member) get 403
// { error, code: "FORBIDDEN" } via the ROLE_RANK max-own guard below
// (mirrors content/screen/route.ts rank >= 3 style). Eligible workspace
// reads go through the USER client (RLS) + scopedQuery, so
// the `.in('workspace_id', workspaceIds)` predicate plus the owner/admin
// audit RLS policy jointly govern visibility. NULL-workspace rows (platform
// actions) are visible to platform only. Matrix: platform full;
// workspace-tier admin/owner read; viewers NONE at the requireAdmin gate,
// members 403 at the route guard. Errors use the
// admin-only envelope { error, code } via toEnvelope().
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  getPagination,
  requireAdminFromSupabase,
  scopedAdminQuery,
  toEnvelope,
} from "@/lib/admin";
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from "@/lib/supabase/server";

const AUDIT_COLUMNS =
  "id,actor,action,target,reason,diff,workspace_id,result,created_at";
const WORKSPACE_FETCH_CAP = 1000;

const ROLE_RANK: Record<string, number> = {
  viewer: 1,
  member: 2,
  admin: 3,
  owner: 4,
};

interface AuditEntry {
  id: string;
  actor: string | null;
  action: string;
  target: unknown;
  reason: string | null;
  diff: unknown;
  workspace_id: string | null;
  result: string;
  created_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asAuditEntries(value: unknown): AuditEntry[] {
  if (!Array.isArray(value)) return [];
  const out: AuditEntry[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (
      typeof item["id"] !== "string" ||
      typeof item["action"] !== "string" ||
      typeof item["created_at"] !== "string"
    ) {
      continue;
    }
    const actor = item["actor"];
    const reason = item["reason"];
    const ws = item["workspace_id"];
    const result = item["result"];
    out.push({
      id: item["id"] as string,
      actor: typeof actor === "string" ? actor : null,
      action: item["action"] as string,
      target: item["target"] ?? null,
      reason: typeof reason === "string" ? reason : null,
      diff: item["diff"] ?? null,
      workspace_id: typeof ws === "string" ? ws : null,
      result: typeof result === "string" ? result : "",
      created_at: item["created_at"] as string,
    });
  }
  return out;
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
    // S7-strict guard (spec §7 audit read-only for admin/owner): workspace
    // tier needs admin/owner (max-own rank >= 3 across the caller's scoped
    // workspaces); members (and any viewer that reaches here) get 403
    // { error, code: "FORBIDDEN" }. Platform tier bypasses. Mirrors the
    // content/screen/route.ts ROLE_RANK pattern; the audit RLS policy
    // re-enforces owner/admin read at the row level.
    if (admin.tier !== "platform") {
      if (admin.workspaceIds.length === 0) {
        return NextResponse.json(
          { error: "Audit log requires an admin role or higher", code: "FORBIDDEN" },
          { status: 403 },
        );
      }
      const guardClient = await createServerSupabaseClient();
      const { data: callerRows, error: callerError } = await guardClient
        .from("workspace_members")
        .select("role")
        .eq("user_id", admin.user.id)
        .in("workspace_id", admin.workspaceIds);
      if (callerError) throw callerError;
      let maxRank = 0;
      if (Array.isArray(callerRows)) {
        for (const row of callerRows) {
          if (!isRecord(row)) continue;
          const role = row["role"];
          if (typeof role !== "string") continue;
          const rank = ROLE_RANK[role] ?? 0;
          if (rank > maxRank) maxRank = rank;
        }
      }
      if (maxRank < (ROLE_RANK["admin"] ?? 3)) {
        return NextResponse.json(
          { error: "Audit log requires an admin role or higher", code: "FORBIDDEN" },
          { status: 403 },
        );
      }
    }

    const params = new URL(request.url).searchParams;
    const actor = params.get("actor")?.trim() || null;
    const action = params.get("action")?.trim() || null;
    const { page, limit, offset } = getPagination(params);

    if (admin.tier === "platform") {
      const service = createServiceRoleClient();
      const countQuery = service
        .from("audit_log")
        .select("id", { count: "exact", head: true });
      if (actor) countQuery.eq("actor", actor);
      if (action) countQuery.eq("action", action);
      const countRes = await countQuery;
      if (countRes.error) throw countRes.error;
      const total = typeof countRes.count === "number" ? countRes.count : 0;

      const dataQuery = service
        .from("audit_log")
        .select(AUDIT_COLUMNS)
        .order("created_at", { ascending: false });
      if (actor) dataQuery.eq("actor", actor);
      if (action) dataQuery.eq("action", action);
      const dataRes = await dataQuery.range(offset, offset + limit - 1);
      if (dataRes.error) throw dataRes.error;

      return NextResponse.json({
        entries: asAuditEntries(dataRes.data),
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
        page,
        limit,
      });
    }

    // Workspace tier: USER client (RLS) + scopedQuery. Exact-match filters
    // are parameterized (no PostgREST string interpolation); RLS plus the
    // IN predicate jointly scope rows to the caller's workspaces.
    const userClient = await createServerSupabaseClient();
    const rowsUnknown: unknown = await scopedAdminQuery(
      userClient,
      "audit_log",
      admin.workspaceIds,
      (q) => {
        let builder = q
          .select(AUDIT_COLUMNS)
          .order("created_at", { ascending: false })
          .limit(WORKSPACE_FETCH_CAP);
        if (actor) builder = builder.eq("actor", actor);
        if (action) builder = builder.eq("action", action);
        return builder;
      },
    );
    const all = asAuditEntries(rowsUnknown);
    const total = all.length;
    return NextResponse.json({
      entries: all.slice(offset, offset + limit),
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
      page,
      limit,
      truncated: total >= WORKSPACE_FETCH_CAP,
    });
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}
