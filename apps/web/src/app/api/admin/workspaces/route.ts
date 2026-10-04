// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/workspaces → { workspaces, total, pages, page, limit }
// (spec §§2-3,7). Delegates to queryWorkspacesList (same helper the
// /admin/workspaces page reads directly, so rows are identical).
// Filters: plan (free/pro/team), status (active/suspended),
// q (prefix/contains search on name/slug via the canonical escaper),
// sort allowlist (name/created_at/plan). Per-workspace usage totals:
// members, startups, runs, evidence, estimated spend
// (spend = sum(trace_events.cost_usd) labeled { value, estimated: true }).
// Platform tier reads all rows via service-role. Workspace tier discovers
// scope through the user client (RLS) + scopedQuery, then reads via
// service-role FILTERED to the in-scope workspace ids only
// (same documented exception as /api/admin/users: the workspaces table is
// keyed by id, not workspace_id, so scopedQuery cannot express the read;
// the in-scope id filter guarantees zero cross-rows). NULL-workspace rows
// are N/A here (workspaces always carry their own id).
// Errors use the admin-only envelope { error, code } via toEnvelope().
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  requireAdminFromSupabase,
  toEnvelope,
} from "@/lib/admin";
import { createQueryDeps } from "@/lib/admin-queries/shared";
import { queryWorkspacesList } from "@/lib/admin-queries/workspaces";

export async function GET(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdminFromSupabase();
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }

  try {
    // Parse-first: raw params are extracted before any client is built so
    // invalid-input (400) paths do the minimum work.
    const url = new URL(request.url);
    const deps = await createQueryDeps(admin);
    const dto = await queryWorkspacesList(deps, {
      page: url.searchParams.get("page"),
      limit: url.searchParams.get("limit"),
      sort: url.searchParams.get("sort"),
      order: url.searchParams.get("order"),
      q: url.searchParams.get("q"),
      plan: url.searchParams.get("plan"),
      status: url.searchParams.get("status"),
    });
    return NextResponse.json(dto);
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}
