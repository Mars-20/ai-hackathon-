// ─────────────────────────────────────────────────────────────────────────────
// /admin/workspaces/[id] — workspace detail (Server Component, spec §§2-3,7).
// Reads GET /api/admin/workspaces/[id] through adminApiFetch (no direct
// Supabase reads). Sections: workspace facts (plan + status shown read-only
// with a v1 note — spec §9 non-goal: no plan changing until entitlements
// are defined; the platform PATCH API/RPC stays, UI only is read-only),
// usage metrics (estimated spend labeled), member roster.
// ─────────────────────────────────────────────────────────────────────────────
import Link from "next/link";
import KpiCard from "@/components/admin/KpiCard";
import WorkspaceSwitcher from "@/components/admin/WorkspaceSwitcher";
import {
  loadWorkspaceDetailPageData,
  settledErrorMessage,
} from "@/lib/admin-page-data";

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
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Detail and sibling switcher list are independent — one concurrent
  // loader round (see lib/admin-page-data.ts). Redirects rethrow inside.
  const wsData = await loadWorkspaceDetailPageData(id);

  const body = wsData.detail.body;
  let loadError = settledErrorMessage(
    wsData.detail.error,
    "Failed to load workspace",
  );

  const detail = body !== null ? narrowDetail(body) : null;
  if (detail === null && loadError === null) {
    loadError = "Unexpected workspace response shape";
  }

  // Sibling options for the switcher (auxiliary — never fails the page).
  const siblings: { id: string; name: string; slug: string }[] = [];
  if (isRecord(wsData.siblings.body) && Array.isArray(wsData.siblings.body["workspaces"])) {
    for (const item of wsData.siblings.body["workspaces"] as unknown[]) {
      if (!isRecord(item) || typeof item["id"] !== "string") continue;
      siblings.push({
        id: item["id"] as string,
        name: typeof item["name"] === "string" ? (item["name"] as string) : "",
        slug: typeof item["slug"] === "string" ? (item["slug"] as string) : "",
      });
    }
  }

  if (loadError !== null || detail === null) {
    return (
      <div>
        <Link
          href="/admin/workspaces"
          className="text-sm text-brand-400 hover:text-brand-300"
        >
          ← Workspaces
        </Link>
        <div className="glass rounded-2xl p-10 text-center border border-red-500/20 mt-6">
          <p className="text-red-300 text-sm">
            {loadError ?? "Failed to load workspace"}
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
            href="/admin/workspaces"
            className="text-sm text-brand-400 hover:text-brand-300"
          >
            ← Workspaces
          </Link>
          <h1 className="text-2xl font-black mt-1">
            {detail.name.length > 0 ? detail.name : detail.slug}{" "}
            <span className="gradient-text">Detail</span>
          </h1>
          <p className="text-slate-400 text-sm">
            {detail.slug} · plan {detail.plan} (v1 read-only) · status{" "}
            {detail.status}
          </p>
        </div>
        <WorkspaceSwitcher currentId={detail.id} workspaces={siblings} />
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
        <KpiCard label="Members" value={String(detail.metrics.members)} />
        <KpiCard label="Startups" value={String(detail.metrics.startups)} />
        <KpiCard label="Runs" value={String(detail.metrics.runs)} />
        <KpiCard label="Evidence" value={String(detail.metrics.evidence)} />
        <KpiCard
          label="Spend"
          value={`$${detail.metrics.spend.value.toFixed(2)}`}
          estimated
          hint="COST_TABLE metering, not provider billing"
        />
      </div>

      <div className="glass rounded-2xl p-5 border border-white/5 mb-8">
        <h2 className="text-sm font-bold text-slate-200 mb-2">
          Plan &amp; status{" "}
          <span className="text-slate-500 font-normal">
            (read-only in v1 — spec §9: no plan changing until entitlements
            are defined)
          </span>
        </h2>
        <p className="text-sm text-slate-300">
          Plan <span className="font-mono text-xs">{detail.plan}</span> ·
          status <span className="font-mono text-xs">{detail.status}</span>
        </p>
      </div>

      <h2 className="text-lg font-bold text-slate-200 mb-3">
        Members ({detail.members.length})
      </h2>
      <div className="glass rounded-2xl border border-white/5 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/5">
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Email
              </th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Role
              </th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                User ID
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
                  No members.
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
