// ─────────────────────────────────────────────────────────────────────────────
// /admin/workspaces — workspace directory (Server Component, spec §§2-3,7).
// The list reads DIRECTLY via the admin DAL (runAdminQuery +
// queryWorkspacesList — same helper the GET /api/admin/workspaces route
// delegates to, so rows are identical). Plan column is read-only in v1
// (spec I1 — changing plans needs entitlements sign-off, deferred); per-
// workspace usage (members, startups, runs, evidence, estimated spend).
// Filters: plan (free/pro/team), status (active/suspended), q (name/slug),
// sort allowlist (name/created_at/plan). Includes the WorkspaceSwitcher
// island (workspace-tier callers only see their own workspaces — scoped
// server-side by the API).
// ─────────────────────────────────────────────────────────────────────────────
import Link from "next/link";
import AdminTable, {
  type AdminTableColumn,
  type AdminTableRow,
} from "@/components/admin/AdminTable";
import WorkspaceSwitcher from "@/components/admin/WorkspaceSwitcher";
import {
  buildAdminTableQuery,
  parseAdminTableParams,
} from "@/components/admin/table-helpers";
import { runAdminQuery } from "@/lib/admin-dal";
import { withLocale, type AppLocale } from "@/lib/i18n-path";
import { getTranslations } from "next-intl/server";
import {
  queryWorkspacesList,
  type WorkspaceUsageRow,
} from "@/lib/admin-queries/workspaces";

const WS_SORT_ALLOWLIST = ["name", "created_at", "plan"] as const;
const WS_DEFAULT_SORT = "created_at";

const VALID_PLANS = ["free", "pro", "team"] as const;
const VALID_STATUS = ["active", "suspended"] as const;

function formatDate(iso: string, locale: AppLocale): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleDateString(locale === "ar" ? "ar-EG-u-nu-latn" : "en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function readSingle(
  params: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const raw = params[name];
  if (raw === undefined) return null;
  const value = Array.isArray(raw) ? (raw[0] ?? "") : raw;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export default async function AdminWorkspacesPage({
  searchParams,
  params: routeParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await routeParams;
  const appLocale = locale as AppLocale;
  const wsBase = withLocale("/admin/workspaces", appLocale);
  const t = await getTranslations("admin.workspaces");
  const tShared = await getTranslations("shared");
  const columns: AdminTableColumn[] = [
    { key: "name", label: t("cols.name"), sortable: true },
    { key: "plan", label: t("cols.plan"), sortable: true },
    { key: "status", label: t("cols.status"), sortable: false },
    { key: "usage", label: t("cols.usage"), sortable: false },
    { key: "spend", label: t("cols.spend"), sortable: false },
    { key: "created_at", label: t("cols.created"), sortable: true },
  ];
  const raw = await searchParams;
  const params = parseAdminTableParams(
    raw,
    WS_SORT_ALLOWLIST,
    WS_DEFAULT_SORT,
  );
  const planRaw = readSingle(raw, "plan");
  const plan =
    planRaw !== null &&
    (VALID_PLANS as readonly string[]).includes(planRaw)
      ? planRaw
      : null;
  const statusRaw = readSingle(raw, "status");
  const status =
    statusRaw !== null &&
    (VALID_STATUS as readonly string[]).includes(statusRaw)
      ? statusRaw
      : null;

  // The list reads directly through the DAL (same helper the GET
  // /api/admin/workspaces route delegates to, so rows are identical).
  // DAL data failures arrive as values; gate failures (401 → /login)
  // throw redirect errors that propagate uncaught, exactly like the
  // loader's rethrows. Plan/status are pre-validated here (invalid values
  // mean "no filter"), so the helper never sees junk from the page — the
  // route still validates raw URL strings itself.
  const result = await runAdminQuery((deps) =>
    queryWorkspacesList(deps, {
      page: params.page,
      limit: params.limit,
      sort: params.sort,
      order: params.order,
      q: params.q,
      plan,
      status,
    }),
  );

  let loadError: string | null = null;
  let data: {
    workspaces: WorkspaceUsageRow[];
    total: number;
    pages: number;
    page: number;
    limit: number;
  } | null = null;
  if (result.ok) {
    data = result.data;
  } else {
    loadError = result.error.message;
  }

  const rows: AdminTableRow[] =
    data?.workspaces.map((w) => ({
      key: w.id,
      cells: {
        name: (
          <Link
            href={withLocale(`/admin/workspaces/${encodeURIComponent(w.id)}`, appLocale)}
            className="text-brand-400 hover:text-brand-300"
          >
            {w.name.length > 0 ? w.name : w.slug}
            <span className="block text-xs text-slate-500">{w.slug}</span>
          </Link>
        ),
        plan: (
          <span title={t("planReadonlyTitle")}>
            {w.plan}
            <span className="block text-xs text-slate-500">{t("planReadonlyNote")}</span>
          </span>
        ),
        status:
          w.status === "suspended" ? (
            <span className="text-xs px-2 py-0.5 rounded-full border border-red-500/30 bg-red-500/10 text-red-400">
              suspended
            </span>
          ) : (
            <span className="text-xs px-2 py-0.5 rounded-full border border-green-500/30 bg-green-500/10 text-green-400">
              active
            </span>
          ),
        usage: t("usagePattern", {
          members: w.memberCount,
          startups: w.startupCount,
          runs: w.runs,
          evidence: w.evidenceCount,
        }),
        spend: `$${w.spend.value.toFixed(2)}`,
        created_at: formatDate(w.created_at, appLocale),
      },
    })) ?? [];

  const baseQuery = buildAdminTableQuery(params);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black mb-1">
            {t("titlePrefix")} <span className="gradient-text">{t("titleAccent")}</span>
          </h1>
          <p className="text-slate-400 text-sm">
            {t("sub")}
          </p>
        </div>
        {data !== null && (
          <WorkspaceSwitcher
            currentId={null}
            workspaces={data.workspaces.map((w) => ({
              id: w.id,
              name: w.name,
              slug: w.slug,
            }))}
          />
        )}
      </div>

      <form
        method="get"
        action={wsBase}
        className="flex flex-wrap gap-3 mb-4 items-end"
      >
        <input type="hidden" name="q" value={params.q ?? ""} />
        <input type="hidden" name="sort" value={params.sort} />
        <input type="hidden" name="order" value={params.order} />
        <input type="hidden" name="limit" value={String(params.limit)} />
        <label className="text-xs text-slate-400 space-y-1">
          {t("filters.plan")}
          <select
            name="plan"
            defaultValue={plan ?? ""}
            className="block glass rounded-lg px-2 py-2 text-sm text-slate-200 outline-none border border-white/5 bg-transparent"
          >
            <option value="">{t("filters.allPlans")}</option>
            {VALID_PLANS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-400 space-y-1">
          {t("filters.status")}
          <select
            name="status"
            defaultValue={status ?? ""}
            className="block glass rounded-lg px-2 py-2 text-sm text-slate-200 outline-none border border-white/5 bg-transparent"
          >
            <option value="">{t("filters.allStatuses")}</option>
            {VALID_STATUS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="glass glass-hover px-4 py-2 rounded-xl text-sm border border-white/5 text-slate-300"
        >
          {t("filters.submit")}
        </button>
        {(plan !== null || status !== null) && (
          <Link
            href={withLocale(`/admin/workspaces${baseQuery.length > 0 ? `?${baseQuery}` : ""}`, appLocale)}
            className="text-sm text-slate-500 hover:text-slate-300 px-2 py-2"
          >
            {tShared("actions.clear")}
          </Link>
        )}
      </form>

      {loadError !== null || data === null ? (
        <div className="glass rounded-2xl p-10 text-center border border-red-500/20">
          <p className="text-red-300 text-sm">
            {loadError ?? t("loadFailed")}
          </p>
        </div>
      ) : (
        <AdminTable
          basePath={wsBase}
          columns={columns}
          rows={rows}
          page={data.page}
          limit={data.limit}
          total={data.total}
          pages={data.pages}
          q={params.q}
          sort={params.sort}
          order={params.order}
          searchPlaceholder={t("searchPlaceholder")}
        />
      )}
    </div>
  );
}
