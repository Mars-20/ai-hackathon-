// ─────────────────────────────────────────────────────────────────────────────
// /admin/users — Users table (Server Component, spec §§2-4,7-8). Parses
// list params with parseAdminTableParams (page 20/max 100, q min 2,
// allowlisted sort: email, created_at), fetches the Task 3
// GET /api/admin/users through adminApiFetch (cookies + Bearer token
// forwarded; no direct Supabase reads), and renders rows via AdminTable.
// Row moderation (role change via PATCH, suspend/unsuspend with confirm +
// reason) lives in the UserActions client island; the API routes enforce
// ROLE_RANK anti-escalation, self-suspend 400, and last-admin 409.
// Suspension takes full effect within ~1 hour (ban blocks refresh +
// sign-in; live JWTs expire naturally) — stated in the confirm copy.
// ─────────────────────────────────────────────────────────────────────────────
import AdminTable, {
  type AdminTableColumn,
  type AdminTableRow,
} from "@/components/admin/AdminTable";
import UserActions from "@/components/admin/UserActions";
import {
  buildAdminTableQuery,
  parseAdminTableParams,
} from "@/components/admin/table-helpers";
import { adminApiFetch, AdminApiError } from "@/lib/admin-fetch";
import { isRedirectError } from "next/dist/client/components/redirect-error";

const USERS_SORT_ALLOWLIST = ["email", "created_at"] as const;
const USERS_DEFAULT_SORT = "created_at";

const USERS_COLUMNS: AdminTableColumn[] = [
  { key: "email", label: "Email", sortable: true },
  { key: "created_at", label: "Created", sortable: true },
  { key: "status", label: "Status", sortable: false },
  { key: "workspaces", label: "Workspaces", sortable: false },
  { key: "actions", label: "Actions", sortable: false },
];

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

function asMemberships(value: unknown): MembershipBrief[] {
  if (!Array.isArray(value)) return [];
  const out: MembershipBrief[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (
      typeof item["workspace_id"] === "string" &&
      typeof item["role"] === "string"
    ) {
      out.push({
        workspace_id: item["workspace_id"] as string,
        role: item["role"] as string,
      });
    }
  }
  return out;
}

function narrowUsers(body: unknown): {
  users: AdminUserRow[];
  total: number;
  pages: number;
  page: number;
  limit: number;
} | null {
  if (!isRecord(body)) return null;
  if (!Array.isArray(body["users"])) return null;
  const users: AdminUserRow[] = [];
  for (const item of body["users"] as unknown[]) {
    if (!isRecord(item)) continue;
    if (
      typeof item["id"] !== "string" ||
      typeof item["email"] !== "string" ||
      typeof item["created_at"] !== "string"
    ) {
      continue;
    }
    const status = item["status"];
    users.push({
      id: item["id"] as string,
      email: item["email"] as string,
      created_at: item["created_at"] as string,
      status: status === "suspended" ? "suspended" : "active",
      workspaces: asMemberships(item["workspaces"]),
    });
  }
  const total = typeof body["total"] === "number" ? body["total"] : users.length;
  const pages = typeof body["pages"] === "number" ? body["pages"] : 0;
  const page = typeof body["page"] === "number" ? body["page"] : 1;
  const limit = typeof body["limit"] === "number" ? body["limit"] : 20;
  return { users, total, pages, page, limit };
}

function formatDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = parseAdminTableParams(
    await searchParams,
    USERS_SORT_ALLOWLIST,
    USERS_DEFAULT_SORT,
  );

  let body: unknown = null;
  let loadError: string | null = null;
  try {
    body = await adminApiFetch(
      "/api/admin/users",
      buildAdminTableQuery(params),
    );
  } catch (err: unknown) {
    if (isRedirectError(err)) throw err;
    loadError =
      err instanceof AdminApiError ? err.message : "Failed to load users";
  }

  const data = body !== null ? narrowUsers(body) : null;
  if (data === null && loadError === null) {
    loadError = "Unexpected users response shape";
  }

  // Workspace picker options for the per-row role editor (Task 6
  // follow-up: no raw workspace-ID textbox). Auxiliary fetch — a failure
  // here degrades to the textbox fallback inside UserActions instead of
  // failing the page; 401 redirects are still rethrown.
  let pickerWorkspaces: { id: string; name: string; slug: string }[] = [];
  try {
    const wsBody: unknown = await adminApiFetch(
      "/api/admin/workspaces",
      "page=1&limit=100&sort=name&order=asc",
    );
    if (isRecord(wsBody) && Array.isArray(wsBody["workspaces"])) {
      for (const item of wsBody["workspaces"] as unknown[]) {
        if (!isRecord(item) || typeof item["id"] !== "string") continue;
        pickerWorkspaces.push({
          id: item["id"] as string,
          name: typeof item["name"] === "string" ? (item["name"] as string) : "",
          slug: typeof item["slug"] === "string" ? (item["slug"] as string) : "",
        });
      }
    }
  } catch (err: unknown) {
    if (isRedirectError(err)) throw err;
    pickerWorkspaces = [];
  }

  const rows: AdminTableRow[] =
    data?.users.map((user) => ({
      key: user.id,
      cells: {
        email: user.email,
        created_at: formatDate(user.created_at),
        status:
          user.status === "suspended" ? (
            <span className="text-xs px-2 py-0.5 rounded-full border border-red-500/30 bg-red-500/10 text-red-400">
              suspended
            </span>
          ) : (
            <span className="text-xs px-2 py-0.5 rounded-full border border-green-500/30 bg-green-500/10 text-green-400">
              active
            </span>
          ),
        workspaces:
          user.workspaces.length === 0
            ? "—"
            : user.workspaces
                .map((w) => `${w.workspace_id.slice(0, 8)}… (${w.role})`)
                .join(", "),
        actions: (
          <UserActions
            userId={user.id}
            email={user.email}
            status={user.status}
            workspaces={pickerWorkspaces}
          />
        ),
      },
    })) ?? [];

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-black mb-1">
          Admin <span className="gradient-text">Users</span>
        </h1>
        <p className="text-slate-400 text-sm">
          Profiles + workspace memberships · status from Auth (banned ⇒
          suspended) · email prefix search · sortable email / created
        </p>
      </div>

      {loadError !== null || data === null ? (
        <div className="glass rounded-2xl p-10 text-center border border-red-500/20">
          <p className="text-red-300 text-sm">
            {loadError ?? "Failed to load users"}
          </p>
        </div>
      ) : (
        <AdminTable
          basePath="/admin/users"
          columns={USERS_COLUMNS}
          rows={rows}
          page={data.page}
          limit={data.limit}
          total={data.total}
          pages={data.pages}
          q={params.q}
          sort={params.sort}
          order={params.order}
          searchPlaceholder="Search email prefix (min 2 chars)..."
        />
      )}
    </div>
  );
}
