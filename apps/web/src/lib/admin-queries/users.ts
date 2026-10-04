import "server-only";
import {
  escapePostgrest,
  getPagination,
  parseSearchQuery,
  scopedAdminQuery,
} from "@/lib/admin";
import type { AdminQueryDeps } from "./shared";

const SORT_ALLOWLIST = ["email", "created_at"] as const;
type SortCol = (typeof SORT_ALLOWLIST)[number];

export interface MembershipBrief {
  workspace_id: string;
  role: string;
}

export interface AdminUserRow {
  id: string;
  email: string;
  created_at: string;
  status: "active" | "suspended";
  workspaces: MembershipBrief[];
}

export interface UsersListInput {
  page: string | number | null;
  limit: string | number | null;
  sort: string | null;
  order: string | null;
  q: string | null;
}

export interface UsersListResult {
  users: AdminUserRow[];
  total: number;
  pages: number;
  page: number;
  limit: number;
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
  service: AdminQueryDeps["service"],
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

/**
 * Users list query extracted verbatim from GET /api/admin/users.
 * Validation lives inside: getPagination caps, sort allowlist fallback,
 * parseSearchQuery + escapePostgrest. Two-client order preserved: RLS scope
 * discovery first (workspace tier), filtered service-role reads after.
 */
export async function queryUsersList(
  deps: AdminQueryDeps,
  input: UsersListInput,
): Promise<UsersListResult> {
  const { admin, userClient, service } = deps;
  const { page, limit, offset } = getPagination({
    page: input.page,
    limit: input.limit,
  });
  const rawSort = input.sort ?? "created_at";
  const sort: SortCol = (SORT_ALLOWLIST as readonly string[]).includes(
    rawSort,
  )
    ? (rawSort as SortCol)
    : "created_at";
  const ascending = input.order === "asc";
  const search = parseSearchQuery(input.q);

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
    // Members lookup and suspension statuses need only the page ids, so
    // they run CONCURRENTLY (each is a Supabase roundtrip).
    let members: MemberRow[] = [];
    let suspended = new Set<string>();
    if (pageIds.length > 0) {
      const [mRes, suspendedSet] = await Promise.all([
        service
          .from("workspace_members")
          .select("user_id,workspace_id,role")
          .in("user_id", pageIds),
        fetchSuspendedSet(service, pageIds),
      ]);
      if (mRes.error) throw mRes.error;
      members = asMemberRows(mRes.data);
      suspended = suspendedSet;
    }
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
    return {
      users,
      total,
      pages: limit > 0 ? Math.ceil(total / limit) : 0,
      page,
      limit,
    };
  }

  // Workspace tier: scope discovery via user client (RLS) + scopedQuery
  // (`.in('workspace_id', workspaceIds)` appended inside scopedQuery).
  const scopeUnknown: unknown = await scopedAdminQuery(
    userClient,
    "workspace_members",
    admin.workspaceIds,
    (q) => q.select("user_id,workspace_id,role"),
  );
  const scopeMembers = asMemberRows(scopeUnknown);
  const inScopeIds = [...new Set(scopeMembers.map((m) => m.user_id))];
  if (inScopeIds.length === 0) {
    return { users: [], total: 0, pages: 0, page, limit };
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
  return {
    users,
    total,
    pages: limit > 0 ? Math.ceil(total / limit) : 0,
    page,
    limit,
  };
}
