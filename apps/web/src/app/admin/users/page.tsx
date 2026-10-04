// ─────────────────────────────────────────────────────────────────────────────
// /admin/users — Users table (Server Component, spec §§2-4,7-8). Parses
// list params with parseAdminTableParams (page 20/max 100, q min 2,
// allowlisted sort: email, created_at). The users list reads DIRECTLY via
// the admin DAL (runAdminQuery + queryUsersList — same helper the
// GET /api/admin/users route delegates to, so rows are identical); the
// workspace picker still comes from loadUsersPageData until Task 2 moves it
// to queryWorkspacesList (temporary DAL + loader mix). Both fire
// concurrently. Row moderation (role change via PATCH, suspend/unsuspend
// with confirm + reason) lives in the UserActions client island; the API
// routes enforce ROLE_RANK anti-escalation, self-suspend 400, and
// last-admin 409. Suspension takes full effect within ~1 hour (ban blocks
// refresh + sign-in; live JWTs expire naturally) — stated in the confirm copy.
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
import { runAdminQuery } from "@/lib/admin-dal";
import {
  queryUsersList,
  type AdminUserRow,
} from "@/lib/admin-queries/users";
import { loadUsersPageData } from "@/lib/admin-page-data";

const USERS_SORT_ALLOWLIST = ["email", "created_at"] as const;
const USERS_DEFAULT_SORT = "created_at";

const USERS_COLUMNS: AdminTableColumn[] = [
  { key: "email", label: "Email", sortable: true },
  { key: "created_at", label: "Created", sortable: true },
  { key: "status", label: "Status", sortable: false },
  { key: "workspaces", label: "Workspaces", sortable: false },
  { key: "actions", label: "Actions", sortable: false },
];

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

  // The users list reads directly through the DAL (same helper the route
  // delegates to); the workspace picker still comes from the loader until
  // Task 2. Both fire concurrently. DAL data failures arrive as values;
  // gate failures (401 → /login) throw redirect errors that propagate
  // uncaught from the Promise.all, exactly like the loader's rethrows.
  const [usersResult, loaded] = await Promise.all([
    runAdminQuery((deps) =>
      queryUsersList(deps, {
        page: params.page,
        limit: params.limit,
        sort: params.sort,
        order: params.order,
        q: params.q,
      }),
    ),
    loadUsersPageData(buildAdminTableQuery(params)),
  ]);
  const pickerWorkspaces = loaded.pickerWorkspaces;

  let loadError: string | null = null;
  let data: {
    users: AdminUserRow[];
    total: number;
    pages: number;
    page: number;
    limit: number;
  } | null = null;
  if (usersResult.ok) {
    data = usersResult.data;
  } else {
    loadError = usersResult.error.message;
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
