// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/analytics/experiments → sortable experiment table
// (Task 5 analytics module). Sort columns allowlist: name, status,
// sample_size (?sort=, ?order=asc|desc; invalid → 400). Pagination via
// getPagination (defaults page 20 / max 100). ?format=csv returns the full
// sorted (cap-bound) set as text/csv with a header row.
// Column semantics: name = parent startup name (fallback: design.title);
// status = experiments.status; sample_size = design.target_sample_size
// (recruitment target — observed sample lives on evidence rows).
// Sorting/pagination apply post-fetch within the server cap
// (EXPERIMENT_CAP 2000); `truncated: true` signals the cap bound (T3-I2 /
// T4-I4 follow-up). NULL-workspace legacy rows EXCLUDED on the platform
// path; workspace path via user client (RLS) + scopedQuery. CSV never
// embeds raw newlines unescaped (RFC 4180 quoting). Matrix: platform full;
// workspace-tier member+ read scoped to own workspaces; viewers NONE at
// the requireAdmin gate. Errors use the admin-only envelope via
// toEnvelope().
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  getPagination,
  requireAdminFromSupabase,
  scopedAdminQuery,
  toEnvelope,
} from "@/lib/admin";
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from "@/lib/supabase/server";

const EXPERIMENT_CAP = 2000;
const STARTUP_LOOKUP_CAP = 2000;

const SORT_ALLOWLIST = ["name", "status", "sample_size"] as const;
type SortCol = (typeof SORT_ALLOWLIST)[number];

interface ExperimentRow {
  id: string;
  startup_id: string;
  workspace_id: string | null;
  status: string;
  type: string;
  design: unknown;
  created_at: string;
}

interface ExperimentView {
  id: string;
  name: string;
  startup_id: string;
  status: string;
  type: string;
  sample_size: number;
  created_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asExperimentRows(value: unknown): ExperimentRow[] {
  if (!Array.isArray(value)) return [];
  const out: ExperimentRow[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (
      typeof item["id"] !== "string" ||
      typeof item["startup_id"] !== "string" ||
      typeof item["created_at"] !== "string"
    ) {
      continue;
    }
    const ws = item["workspace_id"];
    out.push({
      id: item["id"] as string,
      startup_id: item["startup_id"] as string,
      workspace_id: typeof ws === "string" ? ws : null,
      status: typeof item["status"] === "string" ? item["status"] : "",
      type: typeof item["type"] === "string" ? item["type"] : "",
      design: item["design"] ?? null,
      created_at: item["created_at"] as string,
    });
  }
  return out;
}

function designTitle(design: unknown): string | null {
  if (!isRecord(design)) return null;
  const title = design["title"];
  return typeof title === "string" && title.length > 0 ? title : null;
}

function designSampleSize(design: unknown): number {
  if (!isRecord(design)) return 0;
  const size = design["target_sample_size"];
  return typeof size === "number" && Number.isFinite(size) && size >= 0
    ? Math.floor(size)
    : 0;
}

function toViews(
  rows: ExperimentRow[],
  nameByStartup: Map<string, string>,
): ExperimentView[] {
  return rows.map((r) => ({
    id: r.id,
    name: nameByStartup.get(r.startup_id) ?? designTitle(r.design) ?? "Untitled",
    startup_id: r.startup_id,
    status: r.status,
    type: r.type,
    sample_size: designSampleSize(r.design),
    created_at: r.created_at,
  }));
}

function sortViews(views: ExperimentView[], sort: SortCol, order: "asc" | "desc"): ExperimentView[] {
  const dir = order === "desc" ? -1 : 1;
  return [...views].sort((x, y) => {
    let cmp = 0;
    if (sort === "name") cmp = x.name.localeCompare(y.name);
    else if (sort === "status") cmp = x.status.localeCompare(y.status);
    else cmp = x.sample_size - y.sample_size;
    if (cmp === 0) cmp = x.created_at.localeCompare(y.created_at);
    return cmp * dir;
  });
}

function csvEscape(value: string | number): string {
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function toCsv(views: ExperimentView[]): string {
  const header = "id,name,startup_id,status,type,sample_size,created_at";
  const lines = views.map((v) =>
    [
      csvEscape(v.id),
      csvEscape(v.name),
      csvEscape(v.startup_id),
      csvEscape(v.status),
      csvEscape(v.type),
      csvEscape(v.sample_size),
      csvEscape(v.created_at),
    ].join(","),
  );
  return [header, ...lines].join("\n") + "\n";
}

export async function GET(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdminFromSupabase();
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }

  try {
    const params = new URL(request.url).searchParams;
    const rawSort = (params.get("sort") ?? "name").trim().toLowerCase();
    if (!(SORT_ALLOWLIST as readonly string[]).includes(rawSort)) {
      return NextResponse.json(
        { error: "Invalid sort (expected name, status, sample_size)", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }
    const sort = rawSort as SortCol;
    const rawOrder = (params.get("order") ?? "asc").trim().toLowerCase();
    if (rawOrder !== "asc" && rawOrder !== "desc") {
      return NextResponse.json(
        { error: "Invalid order (expected asc or desc)", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }
    const order = rawOrder as "asc" | "desc";
    const rawFormat = (params.get("format") ?? "json").trim().toLowerCase();
    if (rawFormat !== "json" && rawFormat !== "csv") {
      return NextResponse.json(
        { error: "Invalid format (expected json or csv)", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }
    const { page, limit, offset } = getPagination(params);

    let experiments: ExperimentRow[];
    let truncated = false;
    const nameByStartup = new Map<string, string>();

    if (admin.tier === "platform") {
      const service = createServiceRoleClient();
      // NULL workspace_id rows EXCLUDED — never attributed.
      const expRes = await service
        .from("experiments")
        .select("id,startup_id,workspace_id,status,type,design,created_at")
        .not("workspace_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(EXPERIMENT_CAP);
      if (expRes.error) throw expRes.error;
      experiments = asExperimentRows(expRes.data);
      if (experiments.length >= EXPERIMENT_CAP) truncated = true;

      const startupIds = [...new Set(experiments.map((r) => r.startup_id))];
      for (let i = 0; i < startupIds.length; i += 200) {
        const chunk = startupIds.slice(i, i + 200);
        if (chunk.length === 0) continue;
        const startupRes = await service
          .from("startups")
          .select("id,name")
          .in("id", chunk)
          .limit(STARTUP_LOOKUP_CAP);
        if (startupRes.error) throw startupRes.error;
        if (Array.isArray(startupRes.data)) {
          if (startupRes.data.length >= STARTUP_LOOKUP_CAP) truncated = true;
          for (const s of startupRes.data) {
            if (!isRecord(s)) continue;
            if (typeof s["id"] === "string" && typeof s["name"] === "string") {
              nameByStartup.set(s["id"] as string, s["name"] as string);
            }
          }
        }
      }
    } else {
      // Workspace tier: user client (RLS) + scopedQuery for both reads —
      // the `.in('workspace_id', workspaceIds)` predicate is appended
      // inside scopedQuery (NULL rows never match the IN list).
      const userClient = await createServerSupabaseClient();
      const expRowsUnknown: unknown = await scopedAdminQuery(
        userClient,
        "experiments",
        admin.workspaceIds,
        (q) =>
          q
            .select("id,startup_id,workspace_id,status,type,design,created_at")
            .order("created_at", { ascending: false })
            .limit(EXPERIMENT_CAP),
      );
      experiments = asExperimentRows(expRowsUnknown);
      if (experiments.length >= EXPERIMENT_CAP) truncated = true;

      const startupRowsUnknown: unknown = await scopedAdminQuery(
        userClient,
        "startups",
        admin.workspaceIds,
        (q) => q.select("id,name").limit(STARTUP_LOOKUP_CAP),
      );
      const startupRows: unknown[] = Array.isArray(startupRowsUnknown)
        ? startupRowsUnknown
        : [];
      if (startupRows.length >= STARTUP_LOOKUP_CAP) truncated = true;
      for (const s of startupRows) {
        if (!isRecord(s)) continue;
        if (typeof s["id"] === "string" && typeof s["name"] === "string") {
          nameByStartup.set(s["id"] as string, s["name"] as string);
        }
      }
    }

    const sorted = sortViews(toViews(experiments, nameByStartup), sort, order);

    if (rawFormat === "csv") {
      return new NextResponse(toCsv(sorted), {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": "attachment; filename=admin-experiments.csv",
        },
      });
    }

    const total = sorted.length;
    return NextResponse.json({
      experiments: sorted.slice(offset, offset + limit),
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
      page,
      limit,
      sort,
      order,
      truncated,
    });
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}
