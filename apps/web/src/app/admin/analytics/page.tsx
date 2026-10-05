// ─────────────────────────────────────────────────────────────────────────────
// /admin/analytics — product analytics (Server Component, spec §§2-3,5,7).
// Reads DIRECTLY via the admin DAL (runAdminQuery + queryAnalytics /
// queryExperiments — same helpers the GET routes delegate to, so figures
// are identical): signups, runs/day + cost/day trends, verdict
// distribution, cost per run (estimated), unsupported-claim rate. Charts
// are inline SVG bars (no chart lib, YAGNI). The AnalyticsAutoRefresh
// island re-renders the server graphs every 60s (pausing while the tab is
// hidden); the ReportGenerator island builds experiments CSV downloads
// (GET /api/admin/analytics/experiments?format=csv). Window presets
// 7d/30d/90d; workspace-tier rows are scoped server-side by the helper.
// ─────────────────────────────────────────────────────────────────────────────
import Link from "next/link";
import AnalyticsAutoRefresh from "@/components/admin/AnalyticsAutoRefresh";
import KpiCard from "@/components/admin/KpiCard";
import ReportGenerator from "@/components/admin/ReportGenerator";
import { runAdminQuery } from "@/lib/admin-dal";
import {
  queryAnalytics,
  queryExperiments,
} from "@/lib/admin-queries/analytics";

const WINDOWS = ["7d", "30d", "90d"] as const;

interface TrendPoint {
  day: string;
  runs: number;
  cost: number;
}

interface AnalyticsBody {
  distribution: { go: number; iterate: number; stop: number; test_more: number; total: number };
  trends: TrendPoint[];
  costPerRun: { value: number } | null;
  signups: number;
  unsupportedClaimRate: number | null;
  truncated: boolean;
}

interface ExperimentView {
  id: string;
  name: string;
  status: string;
  type: string;
  sample_size: number;
  created_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function narrowAnalytics(body: unknown): AnalyticsBody | null {
  if (!isRecord(body)) return null;
  const distRaw = body["distribution"];
  const trendsRaw = body["trends"];
  if (!isRecord(distRaw) || !Array.isArray(trendsRaw)) return null;
  const go = asNumber(distRaw["go"]);
  const iterate = asNumber(distRaw["iterate"]);
  const stop = asNumber(distRaw["stop"]);
  const testMore = asNumber(distRaw["test_more"]);
  const total = asNumber(distRaw["total"]);
  const signups = asNumber(body["signups"]);
  if (
    go === null ||
    iterate === null ||
    stop === null ||
    testMore === null ||
    total === null ||
    signups === null
  ) {
    return null;
  }
  const trends: TrendPoint[] = [];
  for (const item of trendsRaw) {
    if (!isRecord(item) || typeof item["day"] !== "string") continue;
    const runs = asNumber(item["runs"]);
    const cost = asNumber(item["cost"]);
    if (runs === null || cost === null) continue;
    trends.push({ day: item["day"] as string, runs, cost });
  }
  const cprRaw = body["costPerRun"];
  const costPerRun =
    isRecord(cprRaw) && asNumber(cprRaw["value"]) !== null
      ? { value: asNumber(cprRaw["value"]) as number }
      : null;
  const ucrRaw = body["unsupportedClaimRate"];
  const unsupportedClaimRate =
    typeof ucrRaw === "number" && Number.isFinite(ucrRaw) ? ucrRaw : null;
  return {
    distribution: { go, iterate, stop, test_more: testMore, total },
    trends,
    costPerRun,
    signups,
    unsupportedClaimRate,
    truncated: body["truncated"] === true,
  };
}

function narrowExperiments(body: unknown): {
  experiments: ExperimentView[];
  total: number;
} | null {
  if (!isRecord(body) || !Array.isArray(body["experiments"])) return null;
  const experiments: ExperimentView[] = [];
  for (const item of body["experiments"] as unknown[]) {
    if (!isRecord(item)) continue;
    if (
      typeof item["id"] !== "string" ||
      typeof item["name"] !== "string" ||
      typeof item["created_at"] !== "string"
    ) {
      continue;
    }
    experiments.push({
      id: item["id"] as string,
      name: item["name"] as string,
      status: typeof item["status"] === "string" ? (item["status"] as string) : "",
      type: typeof item["type"] === "string" ? (item["type"] as string) : "",
      sample_size:
        typeof item["sample_size"] === "number" ? (item["sample_size"] as number) : 0,
      created_at: item["created_at"] as string,
    });
  }
  const total =
    typeof body["total"] === "number" ? body["total"] : experiments.length;
  return { experiments, total };
}

function RunsChart({ trends }: { trends: TrendPoint[] }) {
  const width = 640;
  const height = 180;
  const pad = 28;
  const maxRuns = Math.max(1, ...trends.map((t) => t.runs));
  const n = Math.max(1, trends.length);
  const slot = (width - pad * 2) / n;
  const barW = Math.max(2, Math.min(24, slot * 0.6));
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full h-44"
      role="img"
      aria-label="Runs per day bar chart"
    >
      {trends.map((t, i) => {
        const h = ((height - pad * 2) * t.runs) / maxRuns;
        const x = pad + slot * i + (slot - barW) / 2;
        const y = height - pad - h;
        return (
          <g key={t.day}>
            {/* NOTE: <desc>, not <title>. React 19 treats <title> as a
                hoistable head resource even inside <svg>, so SSR streams
                it as an empty element while Flight keeps the text — a
                guaranteed hydration mismatch (React error #418). <desc>
                carries the same accessible description with no hoisting. */}
            <desc>
              {t.day}: {t.runs} runs, ${t.cost.toFixed(2)}
            </desc>
            <rect
              x={x}
              y={y}
              width={barW}
              height={Math.max(1, h)}
              rx={2}
              className="fill-brand-500/70"
            />
          </g>
        );
      })}
      <line
        x1={pad}
        y1={height - pad}
        x2={width - pad}
        y2={height - pad}
        className="stroke-white/10"
      />
      {trends.length > 0 && (
        <>
          <text x={pad} y={height - 8} className="fill-slate-500 text-[10px]">
            {trends[0]?.day}
          </text>
          <text
            x={width - pad}
            y={height - 8}
            textAnchor="end"
            className="fill-slate-500 text-[10px]"
          >
            {trends[trends.length - 1]?.day}
          </text>
        </>
      )}
    </svg>
  );
}

function DistributionBars({
  distribution,
}: {
  distribution: AnalyticsBody["distribution"];
}) {
  const entries: { label: string; count: number; cls: string }[] = [
    { label: "go", count: distribution.go, cls: "bg-green-500/70" },
    { label: "iterate", count: distribution.iterate, cls: "bg-yellow-500/70" },
    { label: "stop", count: distribution.stop, cls: "bg-red-500/70" },
    { label: "test_more", count: distribution.test_more, cls: "bg-sky-500/70" },
  ];
  const max = Math.max(1, ...entries.map((e) => e.count));
  return (
    <div className="space-y-2">
      {entries.map((e) => (
        <div key={e.label} className="flex items-center gap-3 text-sm">
          <span className="w-20 text-xs text-slate-400">{e.label}</span>
          <div className="flex-1 h-4 rounded bg-white/5 overflow-hidden">
            <div
              className={`h-full rounded ${e.cls}`}
              style={{ width: `${(e.count / max) * 100}%` }}
            />
          </div>
          <span className="w-10 text-right text-xs text-slate-300">
            {e.count}
          </span>
        </div>
      ))}
    </div>
  );
}

export default async function AdminAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const windowRaw = raw["window"];
  const windowStr = Array.isArray(windowRaw)
    ? (windowRaw[0] ?? "7d")
    : (windowRaw ?? "7d");
  const window: string = (WINDOWS as readonly string[]).includes(windowStr)
    ? windowStr
    : "7d";

  // Snapshot and experiments table are independent — one concurrent DAL
  // round (same helpers the GET routes delegate to, so figures are
  // identical). Gate failures (401 → /login) throw redirect errors that
  // propagate uncaught; data failures arrive as values and the snapshot
  // renders its error panel, exactly like the loader's settled pattern.
  const [analyticsResult, experimentsResult] = await Promise.all([
    runAdminQuery((deps) =>
      queryAnalytics(deps, { window, from: null, to: null }),
    ),
    runAdminQuery((deps) =>
      queryExperiments(deps, {
        sort: "name",
        order: "asc",
        page: "1",
        limit: "20",
      }),
    ),
  ]);

  const body = analyticsResult.ok === true ? analyticsResult.data : null;
  let loadError =
    analyticsResult.ok === true
      ? null
      : (analyticsResult.error.message ?? "Failed to load analytics");

  const data = body !== null ? narrowAnalytics(body) : null;
  if (data === null && loadError === null) {
    loadError = "Unexpected analytics response shape";
  }

  // Experiments table (auxiliary — never fails the analytics snapshot).
  let experiments: ExperimentView[] = [];
  let experimentsTotal = 0;
  const narrowed =
    experimentsResult.ok === true
      ? narrowExperiments(experimentsResult.data)
      : null;
  if (narrowed !== null) {
    experiments = narrowed.experiments;
    experimentsTotal = narrowed.total;
  }

  const totalRuns = (data?.trends ?? []).reduce((sum, t) => sum + t.runs, 0);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black mb-1">
            Admin <span className="gradient-text">Analytics</span>
          </h1>
          <p className="text-slate-400 text-sm">
            Costs are estimated (COST_TABLE metering, not provider billing)
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex gap-1">
            {WINDOWS.map((w) => (
              <Link
                key={w}
                href={`/admin/analytics?window=${w}`}
                className={`text-xs px-3 py-1.5 rounded-xl border transition-colors ${
                  window === w
                    ? "border-brand-500/50 bg-brand-500/10 text-brand-300"
                    : "border-white/10 text-slate-400 hover:bg-white/5"
                }`}
              >
                {w}
              </Link>
            ))}
          </div>
          <AnalyticsAutoRefresh />
        </div>
      </div>

      {loadError !== null || data === null ? (
        <div className="glass rounded-2xl p-10 text-center border border-red-500/20">
          <p className="text-red-300 text-sm">
            {loadError ?? "Failed to load analytics"}
          </p>
        </div>
      ) : (
        <>
          {data.truncated && (
            <p className="text-xs text-yellow-400 border border-yellow-500/30 bg-yellow-500/10 rounded-xl px-4 py-2 mb-4">
              Server caps bound this window — figures may be truncated.
            </p>
          )}
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            <KpiCard label={`Runs (${window})`} value={String(totalRuns)} />
            <KpiCard label={`Signups (${window})`} value={String(data.signups)} />
            <KpiCard
              label="Cost / run"
              value={
                data.costPerRun === null
                  ? "—"
                  : `$${data.costPerRun.value.toFixed(2)}`
              }
              estimated={data.costPerRun !== null}
            />
            <KpiCard
              label="Unsupported-claim rate"
              value={
                data.unsupportedClaimRate === null
                  ? "—"
                  : `${(data.unsupportedClaimRate * 100).toFixed(1)}%`
              }
            />
          </div>

          <div className="grid lg:grid-cols-2 gap-4 mb-8">
            <div className="glass rounded-2xl p-5 border border-white/5">
              <h2 className="text-sm font-bold text-slate-200 mb-3">
                Runs per day
              </h2>
              {data.trends.length === 0 ? (
                <p className="text-sm text-slate-500 py-8 text-center">
                  No runs in this window.
                </p>
              ) : (
                <RunsChart trends={data.trends} />
              )}
            </div>
            <div className="glass rounded-2xl p-5 border border-white/5">
              <h2 className="text-sm font-bold text-slate-200 mb-3">
                Verdict distribution ({data.distribution.total} decisions)
              </h2>
              <DistributionBars distribution={data.distribution} />
            </div>
          </div>
        </>
      )}

      <h2 className="text-lg font-bold text-slate-200 mb-3">Experiments</h2>
      <div className="glass rounded-2xl border border-white/5 overflow-x-auto mb-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/5">
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Name
              </th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Status
              </th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Sample size
              </th>
            </tr>
          </thead>
          <tbody>
            {experiments.length === 0 ? (
              <tr>
                <td
                  colSpan={3}
                  className="px-4 py-10 text-center text-sm text-slate-500"
                >
                  No experiments found.
                </td>
              </tr>
            ) : (
              experiments.map((e) => (
                <tr
                  key={e.id}
                  className="border-b border-white/5 last:border-0"
                >
                  <td className="px-4 py-2.5 text-slate-300">{e.name}</td>
                  <td className="px-4 py-2.5 text-slate-300">{e.status}</td>
                  <td className="px-4 py-2.5 text-slate-300">
                    {e.sample_size}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500 mb-4">
        Showing {experiments.length} of {experimentsTotal} ·{" "}
        {experimentsTotal === 0 ? (
          <span className="text-slate-600">No data to export yet</span>
        ) : (
          <a
            href="/api/admin/analytics/experiments?format=csv&sort=name&order=asc"
            download
            className="text-brand-400 hover:text-brand-300"
          >
            Download full CSV
          </a>
        )}
      </p>

      <ReportGenerator total={experimentsTotal} />
    </div>
  );
}
