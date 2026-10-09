// ─────────────────────────────────────────────────────────────────────────────
// /admin/workspaces/[id] — workspace detail (Server Component, spec §§2-3,7).
// Reads DIRECTLY via the admin DAL (runAdminQuery + queryWorkspaceDetail —
// same helper the GET /api/admin/workspaces/[id] route delegates to); the
// sibling switcher list reads queryWorkspacesList. Both fire concurrently.
// Sections: workspace facts (plan + status shown read-only
// with a v1 note — spec §9 non-goal: no plan changing until entitlements
// are defined; the platform PATCH API/RPC stays, UI only is read-only),
// usage metrics (estimated spend labeled), member roster.
// ─────────────────────────────────────────────────────────────────────────────
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import KpiCard from "@/components/admin/KpiCard";
import WorkspaceSwitcher from "@/components/admin/WorkspaceSwitcher";
import { runAdminQuery } from "@/lib/admin-dal";
import { withLocale, type AppLocale } from "@/lib/i18n-path";
import {
  queryWorkspacesList,
  queryWorkspaceDetail,
} from "@/lib/admin-queries/workspaces";

interface MemberRow {
  user_id: string;
  role: string;
  joined_at: string | null;
  email: string;
}

interface WorkspaceDetail {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  created_at: string;
  members: MemberRow[];
  metrics: {
    members: number;
    startups: number;
    evidence: number;
    runs: number;
    spend: { value: number };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asMemberRows(value: unknown): MemberRow[] {
  if (!Array.isArray(value)) return [];
  const out: MemberRow[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item["user_id"] !== "string") continue;
    const joined = item["joined_at"];
    out.push({
      user_id: item["user_id"] as string,
      role: typeof item["role"] === "string" ? (item["role"] as string) : "",
      joined_at: typeof joined === "string" ? joined : null,
      email: typeof item["email"] === "string" ? (item["email"] as string) : "",
    });
  }
  return out;
}

function narrowDetail(body: unknown): WorkspaceDetail | null {
  if (!isRecord(body) || !isRecord(body["workspace"])) return null;
  const ws = body["workspace"] as Record<string, unknown>;
  if (typeof ws["id"] !== "string") return null;
  const metricsRaw = isRecord(body["metrics"])
    ? (body["metrics"] as Record<string, unknown>)
    : {};
  const spendRaw = metricsRaw["spend"];
  return {
    id: ws["id"] as string,
    name: typeof ws["name"] === "string" ? (ws["name"] as string) : "",
    slug: typeof ws["slug"] === "string" ? (ws["slug"] as string) : "",
    plan: typeof ws["plan"] === "string" ? (ws["plan"] as string) : "free",
    status:
      typeof ws["status"] === "string" ? (ws["status"] as string) : "active",
    created_at:
      typeof ws["created_at"] === "string" ? (ws["created_at"] as string) : "",
    members: asMemberRows(body["members"]),
    metrics: {
      members: asNumber(metricsRaw["members"]),
      startups: asNumber(metricsRaw["startups"]),
      evidence: asNumber(metricsRaw["evidence"]),
      runs: asNumber(metricsRaw["runs"]),
      spend: { value: isRecord(spendRaw) ? asNumber(spendRaw["value"]) : 0 },
    },
  };
}

export default async function AdminWorkspaceDetailPage({
  params,
}: {
  params: Promise<{ id: string; locale: string }>;
}) {
  const { id, locale } = await params;
  const appLocale = locale as AppLocale;
  const backHref = withLocale("/admin/workspaces", appLocale);
  const t = await getTranslations("admin.workspaceDetail");
  const tShared = await getTranslations("shared");

  // Detail and sibling switcher list are independent — one concurrent
  // DAL round (same helpers the routes delegate to). DAL data failures
  // arrive as values; gate failures (401 → /login) throw redirect errors
  // that propagate uncaught from the Promise.all, exactly like the
  // loader's rethrows.
  const [detailResult, siblingsResult] = await Promise.all([
    runAdminQuery((deps) => queryWorkspaceDetail(deps, id)),
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

  const body = detailResult.ok ? detailResult.data : null;
  let loadError = detailResult.ok ? null : detailResult.error.message;

  const detail = body !== null ? narrowDetail(body) : null;
  if (detail === null && loadError === null) {
    loadError = t("badShape");
  }

  // Sibling options for the switcher (auxiliary — never fails the page).
  const siblings: { id: string; name: string; slug: string }[] =
    siblingsResult.ok
      ? siblingsResult.data.workspaces.map((w) => ({
          id: w.id,
          name: w.name,
          slug: w.slug,
        }))
      : [];

  if (loadError !== null || detail === null) {
    return (
      <div>
        <Link
          href={backHref}
          className="text-sm text-brand-400 hover:text-brand-300"
        >
          <span className="inline-block rtl:scale-x-[-1]">←</span> {t("backToWorkspaces")}
        </Link>
        <div className="glass rounded-2xl p-10 text-center border border-red-500/20 mt-6">
          <p className="text-red-300 text-sm">
            {loadError ?? t("loadFailed")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link
            href={backHref}
            className="text-sm text-brand-400 hover:text-brand-300"
          >
            <span className="inline-block rtl:scale-x-[-1]">←</span> {t("backToWorkspaces")}
          </Link>
          <h1 className="text-2xl font-black mt-1">
            {detail.name.length > 0 ? detail.name : detail.slug}{" "}
            <span className="gradient-text">{t("titleAccent")}</span>
          </h1>
          <p className="text-slate-400 text-sm">
            {t("subPattern", {
              slug: detail.slug,
              plan: detail.plan,
              status: detail.status,
            })}
          </p>
        </div>
        <WorkspaceSwitcher currentId={detail.id} workspaces={siblings} />
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
        <KpiCard label={t("kpi.members")} value={String(detail.metrics.members)} />
        <KpiCard label={t("kpi.startups")} value={String(detail.metrics.startups)} />
        <KpiCard label={t("kpi.runs")} value={String(detail.metrics.runs)} />
        <KpiCard label={t("kpi.evidence")} value={String(detail.metrics.evidence)} />
        <KpiCard
          label={t("kpi.spend")}
          value={`$${detail.metrics.spend.value.toFixed(2)}`}
          estimated
          hint={tShared("misc.estimatedNote")}
        />
      </div>

      <div className="glass rounded-2xl p-5 border border-white/5 mb-8">
        <h2 className="text-sm font-bold text-slate-200 mb-2">
          {t("planTitle")}{" "}
          <span className="text-slate-500 font-normal">
            {t("planNote")}
          </span>
        </h2>
        <p className="text-sm text-slate-300">
          {t("planLinePattern", { plan: detail.plan, status: detail.status })}
        </p>
      </div>

      <h2 className="text-lg font-bold text-slate-200 mb-3">
        {t("membersPattern", { count: detail.members.length })}
      </h2>
      <div className="glass rounded-2xl border border-white/5 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/5">
              <th className="text-start px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                {t("memberCols.email")}
              </th>
              <th className="text-start px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                {t("memberCols.role")}
              </th>
              <th className="text-start px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                {t("memberCols.userId")}
              </th>
            </tr>
          </thead>
          <tbody>
            {detail.members.length === 0 ? (
              <tr>
                <td
                  colSpan={3}
                  className="px-4 py-10 text-center text-sm text-slate-500"
                >
                  {t("emptyMembers")}
                </td>
              </tr>
            ) : (
              detail.members.map((m) => (
                <tr
                  key={`${m.user_id}-${m.role}`}
                  className="border-b border-white/5 last:border-0"
                >
                  <td className="px-4 py-2.5 text-slate-300">
                    {m.email.length > 0 ? m.email : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-slate-300">{m.role}</td>
                  <td className="px-4 py-2.5 text-slate-500 font-mono text-xs">
                    {m.user_id.slice(0, 8)}…
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
