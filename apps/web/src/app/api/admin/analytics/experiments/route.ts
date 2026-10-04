// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/analytics/experiments → sortable experiment table.
// Delegates to queryExperiments (same helper the /admin/analytics page
// reads directly); the ?format=csv branch calls queryExperimentViews for
// its rows and formats CSV inline (byte-identical output).
// Sort columns allowlist: name, status, sample_size (?sort=,
// ?order=asc|desc; invalid → 400). ?format=json|csv (invalid → 400).
// Validation order sort → order → format → pagination runs BEFORE any reads
// (cheap pre-check in the route; helpers re-validate internally).
// Pagination via getPagination (defaults page 20 / max 100).
// ?format=csv returns the full sorted (cap-bound) set as text/csv with a
// header row. Column semantics: name = parent startup name (fallback:
// design.title); status = experiments.status; sample_size =
// design.target_sample_size (recruitment target — observed sample lives on
// evidence rows). Sorting/pagination apply post-fetch within the server
// cap (EXPERIMENT_CAP 2000); `truncated: true` signals the cap bound
// (T3-I2 / T4-I4 follow-up). NULL-workspace legacy rows EXCLUDED on the
// platform path; workspace path via user client (RLS) + scopedQuery. CSV
// never embeds raw newlines unescaped (RFC 4180 quoting). Matrix:
// platform full; workspace-tier member+ read scoped to own workspaces;
// viewers NONE at the requireAdmin gate. Errors use the admin-only
// envelope via toEnvelope().
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  getPagination,
  requireAdminFromSupabase,
  toEnvelope,
} from "@/lib/admin";
import { createQueryDeps } from "@/lib/admin-queries/shared";
import {
  parseExperimentFormat,
  parseExperimentSortOrder,
  queryExperiments,
  queryExperimentViews,
} from "@/lib/admin-queries/analytics";
import type { ExperimentView } from "@/lib/admin-queries/analytics";

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
    // Cheap pre-validation BEFORE any reads, mirroring the original inline
    // order sort → order → format → pagination (zero DB cost — the helpers
    // re-validate the same inputs internally before reading). This keeps
    // doubly-invalid precedence (sort first) while invalid-format requests
    // never pay the EXPERIMENT_CAP + startup-lookup reads.
    parseExperimentSortOrder({
      sort: params.get("sort"),
      order: params.get("order"),
    });
    const rawFormat = parseExperimentFormat(params.get("format"));
    // Original ran getPagination before the CSV branch even though the CSV
    // rows ignore pagination — restore that call so bogus page/limit go
    // through the same validation on both paths (result intentionally
    // unused here; the JSON helper re-parses for slicing).
    getPagination({ page: params.get("page"), limit: params.get("limit") });

    if (rawFormat === "csv") {
      // CSV branch: rows come from the helper (sort/order re-validate
      // inside and throw before any formatting); formatting stays here,
      // byte-identical.
      const deps = await createQueryDeps(admin);
      const { views } = await queryExperimentViews(deps, {
        sort: params.get("sort"),
        order: params.get("order"),
      });
      return new NextResponse(toCsv(views), {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": "attachment; filename=admin-experiments.csv",
        },
      });
    }

    // JSON branch: format already validated above (no post-read 400, no
    // wasted reads); the helper re-validates sort/order/pagination then
    // reads.
    const deps = await createQueryDeps(admin);
    const dto = await queryExperiments(deps, {
      sort: params.get("sort"),
      order: params.get("order"),
      page: params.get("page"),
      limit: params.get("limit"),
    });
    return NextResponse.json(dto);
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}
