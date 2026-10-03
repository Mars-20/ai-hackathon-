// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/users → { users, total, pages, page, limit } (spec §§2-4).
// Rows sourced from `profiles` (email, created_at) LEFT JOIN
// `workspace_members`, plus live status from the Auth Admin API
// (`banned_until`: banned => "suspended", else "active").
// Email search is a prefix match on `profiles.email` (trigram index) via the
// canonical escapePostgrest(); sortable columns allowlist: email, created_at.
// Platform tier reads all rows via the service-role client. Workspace tier
// discovers scope through the user client (RLS) + scopedQuery — the scoping
// predicate `.in('workspace_id', workspaceIds)` is appended inside
// scopedQuery — then reads profiles via service-role FILTERED to the
// in-scope user ids only (documented profiles-PII exception in
// packages/db/admin-migration.sql: RLS permits own-row + platform-full, so
// cross-user workspace reads must use the filtered service-role path and
// return in-scope rows only). Errors use { error, code } via toEnvelope().
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

const SORT_ALLOWLIST = ["email", "created_at"] as const;
type SortCol = (typeof SORT_ALLOWLIST)[number];

interface MembershipBrief {
  workspace_id: string;
  role: string;
}

interface AdminUserRow {
  id: string;
  email: string;
  created_at: string;
  status: "active" | "suspended";
  workspaces: MembershipBrief[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface ProfileRow {
  user_id: string;
  email: string;
  created_at: string;
}

function asProfileRows(value: unknown): ProfileRow[] {
  if (!Array.isArray(value)) return [];
  const out: ProfileRow[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (typeof item["user_id"] !== "string") continue;
    out.push({
      user_id: item["user_id"] as string,
      email: typeof item["email"] === "string" ? item["email"] : "",
      created_at:
        typeof item["created_at"] === "string" ? item["created_at"] : "",
    });
  }
  return out;
}

interface MemberRow {
  user_id: string;
  workspace_id: string;
  role: string;
}

function asMemberRows(value: unknown): MemberRow[] {
  if (!Array.isArray(value)) return [];
  const out: MemberRow[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (
      typeof item["user_id"] === "string" &&
      typeof item["workspace_id"] === "string" &&
      typeof item["role"] === "string"
    ) {
      out.push({
        user_id: item["user_id"] as string,
        workspace_id: item["workspace_id"] as string,
        role: item["role"] as string,
      });
    }
  }
  return out;
}

async function fetchSuspendedSet(
  service: ReturnType<typeof createServiceRoleClient>,
  userIds: string[],
): Promise<Set<string>> {
  const suspended = new Set<string>();
  await Promise.all(
    userIds.map((id) =>
      service.auth.admin
        .getUserById(id)
        .then(({ data }: { data: unknown }) => {
          if (!isRecord(data)) return;
          const user = data["user"];
          if (!isRecord(user)) return;
          const banned = user["banned_until"];
          if (typeof banned === "string" && banned.length > 0) {
            suspended.add(id);
          }
        })
        .catch(() => undefined),
    ),
  );
  return suspended;
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
    const sort: SortCol = (SORT_ALLOWLIST as readonly string[]).includes(
      rawSort,
    )
      ? (rawSort as SortCol)
      : "created_at";
    const ascending = url.searchParams.get("order") === "asc";
    const search = parseSearchQuery(url.searchParams.get("q"));

    const service = createServiceRoleClient();

    if (admin.tier === "platform") {
      let query = service
        .from("profiles")
        .select("user_id,email,created_at", { count: "exact" })
        .order(sort, { ascending });
      if (search !== null) {
        // Prefix match on profiles.email (trigram index); escape first.
        query = query.ilike("email", `${escapePostgrest(search)}%`);
      }
      query = query.range(offset, offset + limit - 1);
      const { data, count, error } = await query;
      if (error) throw error;
      const profiles = asProfileRows(data);
      const total = typeof count === "number" ? count : profiles.length;

      const pageIds = profiles.map((p) => p.user_id);
      let members: MemberRow[] = [];
      if (pageIds.length > 0) {
        const mRes = await service
          .from("workspace_members")
          .select("user_id,workspace_id,role")
          .in("user_id", pageIds);
        if (mRes.error) throw mRes.error;
        members = asMemberRows(mRes.data);
      }
      const suspended = await fetchSuspendedSet(service, pageIds);
      const byUser = new Map<string, MembershipBrief[]>();
      for (const m of members) {
        const list = byUser.get(m.user_id) ?? [];
        list.push({ workspace_id: m.workspace_id, role: m.role });
        byUser.set(m.user_id, list);
      }
      const users: AdminUserRow[] = profiles.map((p) => ({
        id: p.user_id,
        email: p.email,
        created_at: p.created_at,
        status: suspended.has(p.user_id) ? "suspended" : "active",
        workspaces: byUser.get(p.user_id) ?? [],
      }));
      return NextResponse.json({
        users,
        total,
        pages: limit > 0 ? Math.ceil(total / limit) : 0,
        page,
        limit,
      });
    }

    // Workspace tier: scope discovery via user client (RLS) + scopedQuery
    // (`.in('workspace_id', workspaceIds)` appended inside scopedQuery).
    const userClient = await createServerSupabaseClient();
    const scopeUnknown: unknown = await scopedAdminQuery(
      userClient,
      "workspace_members",
      admin.workspaceIds,
      (q) => q.select("user_id,workspace_id,role"),
    );
    const scopeMembers = asMemberRows(scopeUnknown);
    const inScopeIds = [...new Set(scopeMembers.map((m) => m.user_id))];
    if (inScopeIds.length === 0) {
      return NextResponse.json({ users: [], total: 0, pages: 0, page, limit });
    }

    let query = service
      .from("profiles")
      .select("user_id,email,created_at", { count: "exact" })
      .in("user_id", inScopeIds)
      .order(sort, { ascending });
    if (search !== null) {
      query = query.ilike("email", `${escapePostgrest(search)}%`);
    }
    query = query.range(offset, offset + limit - 1);
    const { data, count, error } = await query;
    if (error) throw error;
    const profiles = asProfileRows(data);
    const total = typeof count === "number" ? count : profiles.length;

    const pageIds = profiles.map((p) => p.user_id);
    const suspended = await fetchSuspendedSet(service, pageIds);
    const byUser = new Map<string, MembershipBrief[]>();
    for (const m of scopeMembers) {
      if (!pageIds.includes(m.user_id)) continue;
      const list = byUser.get(m.user_id) ?? [];
      list.push({ workspace_id: m.workspace_id, role: m.role });
      byUser.set(m.user_id, list);
    }
    const users: AdminUserRow[] = profiles.map((p) => ({
      id: p.user_id,
      email: p.email,
      created_at: p.created_at,
      status: suspended.has(p.user_id) ? "suspended" : "active",
      workspaces: byUser.get(p.user_id) ?? [],
    }));
    return NextResponse.json({
      users,
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
