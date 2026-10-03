// ─────────────────────────────────────────────────────────────────────────────
// /admin — Overview (Server Component, spec §§2-4). Fetches the Task 3
// GET /api/admin/overview through adminApiFetch (cookies + Bearer token
// forwarded; no direct Supabase reads from the page). KPI cards render
// spend with the "estimated" label; trends render as a day-bucketed table
// (date_trunc('day', created_at) equivalent, computed server-side in the
// route). NULL-workspace legacy rows are excluded by the route.
// ─────────────────────────────────────────────────────────────────────────────
import KpiCard from "@/components/admin/KpiCard";
import { adminApiFetch, AdminApiError } from "@/lib/admin-fetch";
import { isRedirectError } from "next/dist/client/components/redirect-error";

interface TrendPoint {
  day: string;
  runs: number;
  cost: number;
}

interface OverviewKpis {
  users: number;
  activeWorkspaces: number;
  startups: number;
  runs7d: number;
  rejectRate: number | null;
  spend: { value: number; estimated: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function narrowOverview(body: unknown): {
  kpis: OverviewKpis;
  trends: TrendPoint[];
} | null {
  if (!isRecord(body)) return null;
  const kpisRaw = body["kpis"];
  const trendsRaw = body["trends"];
  if (!isRecord(kpisRaw) || !Array.isArray(trendsRaw)) return null;
  const users = asNumber(kpisRaw["users"]);
  const activeWorkspaces = asNumber(kpisRaw["activeWorkspaces"]);
  const startups = asNumber(kpisRaw["startups"]);
  const runs7d = asNumber(kpisRaw["runs7d"]);
  const spendRaw = kpisRaw["spend"];
  if (
    users === null ||
    activeWorkspaces === null ||
    startups === null ||
    runs7d === null ||
    !isRecord(spendRaw)
  ) {
    return null;
  }
  const spendValue = asNumber(spendRaw["value"]);
  if (spendValue === null) return null;
  const rejectRaw = kpisRaw["rejectRate"];
  const rejectRate =
    rejectRaw === null || rejectRaw === undefined
      ? null
      : asNumber(rejectRaw);
  if (rejectRaw !== null && rejectRaw !== undefined && rejectRate === null) {
    return null;
  }
  const trends: TrendPoint[] = [];
  for (const item of trendsRaw) {
    if (!isRecord(item)) continue;
    if (typeof item["day"] !== "string") continue;
    const runs = asNumber(item["runs"]);
    const cost = asNumber(item["cost"]);
    if (runs === null || cost === null) continue;
    trends.push({
      day: item["day"] as string,
      runs,
      cost,
    });
  }
  return {
    kpis: {
      users,
      activeWorkspaces,
      startups,
      runs7d,
      rejectRate,
      spend: { value: spendValue, estimated: true },
    },
    trends,
  };
}

export default async function AdminOverviewPage() {
  let body: unknown = null;
  let loadError: string | null = null;
  try {
    body = await adminApiFetch("/api/admin/overview");
  } catch (err: unknown) {
    if (isRedirectError(err)) throw err;
    loadError =
      err instanceof AdminApiError
        ? err.message
        : "Failed to load overview";
  }

  const overview = body !== null ? narrowOverview(body) : null;
  if (overview === null && loadError === null) {
    loadError = "Unexpected overview response shape";
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
