// ─────────────────────────────────────────────────────────────────────────────
// /admin/users — Users table (Server Component, spec §§2-4,7-8). Parses
// list params with parseAdminTableParams (page 20/max 100, q min 2,
// allowlisted sort: email, created_at). The users list reads DIRECTLY via
// the admin DAL (runAdminQuery + queryUsersList — same helper the
// GET /api/admin/users route delegates to, so rows are identical); the
// workspace picker reads queryWorkspacesList (same helper the GET
// /api/admin/workspaces route delegates to). Both fire
// concurrently. Row moderation (role change via PATCH, suspend/unsuspend
// with confirm + reason) lives in the UserActions client island; the API
// routes enforce ROLE_RANK anti-escalation, self-suspend 400, and
// last-admin 409. Suspension takes full effect within ~1 hour (ban blocks
// refresh + sign-in; live JWTs expire naturally) — stated in the confirm copy.
// ─────────────────────────────────────────────────────────────────────────────
import AdminTable, {
  type AdminTableRow,
} from "@/components/admin/AdminTable";
import UserActions from "@/components/admin/UserActions";
import {
  parseAdminTableParams,
} from "@/components/admin/table-helpers";
import { runAdminQuery } from "@/lib/admin-dal";
import { withLocale, type AppLocale } from "@/lib/i18n-path";
import { getTranslations } from "next-intl/server";
import {
  queryUsersList,
  type AdminUserRow,
} from "@/lib/admin-queries/users";
import { queryWorkspacesList } from "@/lib/admin-queries/workspaces";

const USERS_SORT_ALLOWLIST = ["email", "created_at"] as const;
const USERS_DEFAULT_SORT = "created_at";

function formatDate(iso: string, locale: AppLocale): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleDateString(locale === "ar" ? "ar-EG-u-nu-latn" : "en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default async function AdminUsersPage({
  searchParams,
  params,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const appLocale = locale as AppLocale;
  const usersBase = withLocale("/admin/users", appLocale);
  const t = await getTranslations("admin.users");
  const columns = [
    { key: "email", label: t("cols.email"), sortable: true },
    { key: "created_at", label: t("cols.created"), sortable: true },
    { key: "status", label: t("cols.status"), sortable: false },
    { key: "workspaces", label: t("cols.workspaces"), sortable: false },
    { key: "actions", label: t("cols.actions"), sortable: false },
  ];
  const params_ = parseAdminTableParams(
    await searchParams,
    USERS_SORT_ALLOWLIST,
    USERS_DEFAULT_SORT,
  );

  // The users list reads directly through the DAL (same helper the route
  // delegates to); the workspace picker reads queryWorkspacesList (same
  // helper the workspaces route delegates to, same picker params the
  // loader used: page 1, limit 100, name asc). Both fire concurrently.
  // DAL data failures arrive as values; the picker degrades to an empty
  // list on failure; gate failures (401 → /login) throw redirect errors
  // that propagate uncaught from the Promise.all, exactly like the
  // loader's rethrows.
  const [usersResult, pickerResult] = await Promise.all([
    runAdminQuery((deps) =>
      queryUsersList(deps, {
        page: params_.page,
        limit: params_.limit,
        sort: params_.sort,
        order: params_.order,
        q: params_.q,
      }),
    ),
    runAdminQuery((deps) =>
      queryWorkspacesList(deps, {
        page: 1,
        limit: 100,
        sort: "name",
        order: "asc",
        q: null,
        plan: null,
        status: null,
      }),
    ),
  ]);
  const pickerWorkspaces: { id: string; name: string; slug: string }[] =
    pickerResult.ok
      ? pickerResult.data.workspaces.map((w) => ({
          id: w.id,
          name: w.name,
          slug: w.slug,
        }))
      : [];

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
        created_at: formatDate(user.created_at, appLocale),
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
          {t("titlePrefix")} <span className="gradient-text">{t("titleAccent")}</span>
        </h1>
        <p className="text-slate-400 text-sm">
          {t("sub")}
        </p>
      </div>

      {loadError !== null || data === null ? (
        <div className="glass rounded-2xl p-10 text-center border border-red-500/20">
          <p className="text-red-300 text-sm">
            {loadError ?? t("loadFailed")}
          </p>
        </div>
      ) : (
        <AdminTable
          basePath={usersBase}
          columns={columns}
          rows={rows}
          page={data.page}
          limit={data.limit}
          total={data.total}
          pages={data.pages}
          q={params_.q}
          sort={params_.sort}
          order={params_.order}
          searchPlaceholder={t("searchPlaceholder")}
        />
      )}
    </div>
  );
}
