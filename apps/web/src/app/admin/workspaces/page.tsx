// ─────────────────────────────────────────────────────────────────────────────
// /admin/workspaces — workspace directory (Server Component, spec §§2-3,7).
// Lists GET /api/admin/workspaces through adminApiFetch (cookies + Bearer
// forwarded; no direct Supabase reads). Plan column is read-only in v1
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
import { adminApiFetch, AdminApiError } from "@/lib/admin-fetch";
import { isRedirectError } from "next/dist/client/components/redirect-error";

const WS_SORT_ALLOWLIST = ["name", "created_at", "plan"] as const;
const WS_DEFAULT_SORT = "created_at";

const WS_COLUMNS: AdminTableColumn[] = [
  { key: "name", label: "Workspace", sortable: true },
  { key: "plan", label: "Plan", sortable: true },
  { key: "status", label: "Status", sortable: false },
  { key: "usage", label: "Usage", sortable: false },
  { key: "spend", label: "Spend (est.)", sortable: false },
  { key: "created_at", label: "Created", sortable: true },
];

const VALID_PLANS = ["free", "pro", "team"] as const;
const VALID_STATUS = ["active", "suspended"] as const;

interface WorkspaceUsage {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  created_at: string;
  memberCount: number;
  startupCount: number;
  runs: number;
  evidenceCount: number;
  spend: { value: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function narrowWorkspaces(body: unknown): {
  workspaces: WorkspaceUsage[];
  total: number;
  pages: number;
  page: number;
  limit: number;
} | null {
  if (!isRecord(body) || !Array.isArray(body["workspaces"])) return null;
  const workspaces: WorkspaceUsage[] = [];
  for (const item of body["workspaces"] as unknown[]) {
    if (!isRecord(item) || typeof item["id"] !== "string") continue;
    const spendRaw = item["spend"];
    workspaces.push({
      id: item["id"] as string,
      name: typeof item["name"] === "string" ? (item["name"] as string) : "",
      slug: typeof item["slug"] === "string" ? (item["slug"] as string) : "",
      plan: typeof item["plan"] === "string" ? (item["plan"] as string) : "free",
      status:
        typeof item["status"] === "string" ? (item["status"] as string) : "active",
      created_at:
        typeof item["created_at"] === "string"
          ? (item["created_at"] as string)
          : "",
      memberCount: asNumber(item["memberCount"]),
      startupCount: asNumber(item["startupCount"]),
      runs: asNumber(item["runs"]),
      evidenceCount: asNumber(item["evidenceCount"]),
      spend: {
        value: isRecord(spendRaw) ? asNumber(spendRaw["value"]) : 0,
      },
    });
  }
  const total =
    typeof body["total"] === "number" ? body["total"] : workspaces.length;
  const pages = typeof body["pages"] === "number" ? body["pages"] : 0;
  const page = typeof body["page"] === "number" ? body["page"] : 1;
  const limit = typeof body["limit"] === "number" ? body["limit"] : 20;
  return { workspaces, total, pages, page, limit };
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
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
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

  let body: unknown = null;
  let loadError: string | null = null;
  try {
    const qs = new URLSearchParams(buildAdminTableQuery(params));
    if (plan !== null) qs.set("plan", plan);
    if (status !== null) qs.set("status", status);
    body = await adminApiFetch("/api/admin/workspaces", qs.toString());
  } catch (err: unknown) {
    if (isRedirectError(err)) throw err;
    loadError =
      err instanceof AdminApiError ? err.message : "Failed to load workspaces";
  }

  const data = body !== null ? narrowWorkspaces(body) : null;
  if (data === null && loadError === null) {
    loadError = "Unexpected workspaces response shape";
  }

  const rows: AdminTableRow[] =
    data?.workspaces.map((w) => ({
      key: w.id,
      cells: {
        name: (
          <Link
            href={`/admin/workspaces/${encodeURIComponent(w.id)}`}
            className="text-brand-400 hover:text-brand-300"
          >
            {w.name.length > 0 ? w.name : w.slug}
            <span className="block text-xs text-slate-500">{w.slug}</span>
          </Link>
        ),
        plan: (
          <span title="Plan is read-only in v1 (spec I1)">
            {w.plan}
            <span className="block text-xs text-slate-500">v1 read-only</span>
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
        usage: `${w.memberCount} members · ${w.startupCount} startups · ${w.runs} runs · ${w.evidenceCount} evidence`,
        spend: `$${w.spend.value.toFixed(2)}`,
        created_at: formatDate(w.created_at),
      },
    })) ?? [];

  const baseQuery = buildAdminTableQuery(params);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black mb-1">
            Admin <span className="gradient-text">Workspaces</span>
          </h1>
          <p className="text-slate-400 text-sm">
            Plan is read-only in v1 · spend is estimated (COST_TABLE metering,
            not provider billing)
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
        action="/admin/workspaces"
        className="flex flex-wrap gap-3 mb-4 items-end"
      >
        <input type="hidden" name="q" value={params.q ?? ""} />
        <input type="hidden" name="sort" value={params.sort} />
        <input type="hidden" name="order" value={params.order} />
        <input type="hidden" name="limit" value={String(params.limit)} />
        <label className="text-xs text-slate-400 space-y-1">
          Plan
          <select
            name="plan"
            defaultValue={plan ?? ""}
            className="block glass rounded-lg px-2 py-2 text-sm text-slate-200 outline-none border border-white/5 bg-transparent"
          >
            <option value="">All plans</option>
            {VALID_PLANS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-400 space-y-1">
          Status
          <select
            name="status"
            defaultValue={status ?? ""}
            className="block glass rounded-lg px-2 py-2 text-sm text-slate-200 outline-none border border-white/5 bg-transparent"
          >
            <option value="">All statuses</option>
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
          Filter
        </button>
        {(plan !== null || status !== null) && (
          <Link
            href={`/admin/workspaces${baseQuery.length > 0 ? `?${baseQuery}` : ""}`}
            className="text-sm text-slate-500 hover:text-slate-300 px-2 py-2"
          >
            Clear
          </Link>
        )}
      </form>

      {loadError !== null || data === null ? (
        <div className="glass rounded-2xl p-10 text-center border border-red-500/20">
          <p className="text-red-300 text-sm">
            {loadError ?? "Failed to load workspaces"}
          </p>
        </div>
      ) : (
        <AdminTable
          basePath="/admin/workspaces"
          columns={WS_COLUMNS}
          rows={rows}
          page={data.page}
          limit={data.limit}
          total={data.total}
          pages={data.pages}
          q={params.q}
          sort={params.sort}
          order={params.order}
          searchPlaceholder="Search name/slug (min 2 chars)..."
        />
      )}
    </div>
  );
}
