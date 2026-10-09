// ─────────────────────────────────────────────────────────────────────────────
// /admin — Overview (Server Component, spec §§2-4). Reads DIRECTLY via the
// admin DAL (runAdminQuery + queryOverview — same helper the GET
// /api/admin/overview route delegates to, so figures are identical). KPI
// cards render spend with the "estimated" label; trends render as a
// day-bucketed table (date_trunc('day', created_at) equivalent, computed
// in the helper). NULL-workspace legacy rows are excluded by the helper.
// ─────────────────────────────────────────────────────────────────────────────
import KpiCard from "@/components/admin/KpiCard";
import { runAdminQuery } from "@/lib/admin-dal";
import { getTranslations } from "next-intl/server";
import {
  queryOverview,
  type OverviewKpis,
  type TrendPoint,
} from "@/lib/admin-queries/overview";

export default async function AdminOverviewPage() {
  const t = await getTranslations("admin.overview");
  const tShared = await getTranslations("shared");
  // Direct DAL read (same helper the route delegates to). Data failures
  // arrive as values; gate failures (401 → /login) throw redirect errors
  // that propagate uncaught, exactly like the loader's rethrows.
  const result = await runAdminQuery((deps) => queryOverview(deps, 7));

  let loadError: string | null = null;
  let overview: { kpis: OverviewKpis; trends: TrendPoint[] } | null = null;
  if (result.ok) {
    overview = result.data;
  } else {
    loadError = result.error.message;
  }

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

      {loadError !== null || overview === null ? (
        <div className="glass rounded-2xl p-10 text-center border border-red-500/20">
          <p className="text-red-300 text-sm">
            {loadError ?? t("loadFailed")}
          </p>
        </div>
      ) : (
        <>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
            <KpiCard label={t("kpi.users")} value={String(overview.kpis.users)} />
            <KpiCard
              label={t("kpi.activeWorkspaces")}
              value={String(overview.kpis.activeWorkspaces)}
              hint={t("hints.activeWorkspaces")}
            />
            <KpiCard
              label={t("kpi.startups")}
              value={String(overview.kpis.startups)}
            />
            <KpiCard
              label={t("kpi.runs7d")}
              value={String(overview.kpis.runs7d)}
            />
            <KpiCard
              label={t("kpi.rejectRate")}
              value={
                overview.kpis.rejectRate === null
                  ? "—"
                  : `${(overview.kpis.rejectRate * 100).toFixed(1)}%`
              }
            />
            <KpiCard
              label={t("kpi.spend")}
              value={`$${overview.kpis.spend.value.toFixed(2)}`}
              estimated
              hint={tShared("misc.estimatedNote")}
            />
          </div>

          <h2 className="text-lg font-bold text-slate-200 mb-3">
            {t("trendsTitle")}
          </h2>
          <div className="glass rounded-2xl border border-white/5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/5">
                  <th className="text-start px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    {t("cols.day")}
                  </th>
                  <th className="text-start px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    {t("cols.runs")}
                  </th>
                  <th className="text-start px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    {t("cols.cost")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {overview.trends.length === 0 ? (
                  <tr>
                    <td
                      colSpan={3}
                      className="px-4 py-10 text-center text-sm text-slate-500"
                    >
                      {tShared("misc.noRunsInWindow")}
                    </td>
                  </tr>
                ) : (
                  overview.trends.map((point) => (
                    <tr
                      key={point.day}
                      className="border-b border-white/5 last:border-0"
                    >
                      <td className="px-4 py-2.5 text-slate-300">
                        {point.day}
                      </td>
                      <td className="px-4 py-2.5 text-slate-300">
                        {point.runs}
                      </td>
                      <td className="px-4 py-2.5 text-slate-300">
                        ${point.cost.toFixed(2)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
