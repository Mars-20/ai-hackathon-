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
import {
  queryOverview,
  type OverviewKpis,
  type TrendPoint,
} from "@/lib/admin-queries/overview";

export default async function AdminOverviewPage() {
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
          Admin <span className="gradient-text">Overview</span>
        </h1>
        <p className="text-slate-400 text-sm">
          Trailing 7 days · NULL-workspace rows excluded · spend is estimated
        </p>
      </div>

      {loadError !== null || overview === null ? (
        <div className="glass rounded-2xl p-10 text-center border border-red-500/20">
          <p className="text-red-300 text-sm">
            {loadError ?? "Failed to load overview"}
          </p>
        </div>
      ) : (
        <>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
            <KpiCard label="Users" value={String(overview.kpis.users)} />
            <KpiCard
              label="Active workspaces"
              value={String(overview.kpis.activeWorkspaces)}
              hint="≥1 agent run in trailing 7d"
            />
            <KpiCard
              label="Startups"
              value={String(overview.kpis.startups)}
            />
            <KpiCard
              label="Runs (7d)"
              value={String(overview.kpis.runs7d)}
            />
            <KpiCard
              label="Verifier reject rate"
              value={
                overview.kpis.rejectRate === null
                  ? "—"
                  : `${(overview.kpis.rejectRate * 100).toFixed(1)}%`
              }
            />
            <KpiCard
              label="Spend (7d)"
              value={`$${overview.kpis.spend.value.toFixed(2)}`}
              estimated
              hint="COST_TABLE metering, not provider billing"
            />
          </div>

          <h2 className="text-lg font-bold text-slate-200 mb-3">
            Daily trends
          </h2>
          <div className="glass rounded-2xl border border-white/5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/5">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Day
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Runs
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Cost (est.)
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
                      No runs in this window.
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
