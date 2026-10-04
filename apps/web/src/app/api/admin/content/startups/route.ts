// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/content/startups → { startups, total, pages, page, limit }
// (spec §§2-3,7). Content review queue: flagged-first default ordering,
// filters flagged / verdict / confidence, full-text q over startup
// name/one_liner/domain + evidence claims + lead emails (canonical
// escapePostgrest on every fragment; raw q is never interpolated).
// Verdict/confidence match when ANY decision on the startup matches
// (documented semantic). Platform tier reads all rows via service-role
// (NULL-workspace rows EXCLUDED via `.not('workspace_id', 'is', null)`).
// Workspace tier reads through the user client (RLS) + scopedQuery — the
// scoping predicate `.in('workspace_id', workspaceIds)` is appended inside
// scopedQuery (NULL rows never match the IN list); the total count reuses
// the Task-3 users-route pattern (service-role count strictly filtered to
// the in-scope workspace ids — a number, never row data).
// Query implementation lives in @/lib/admin-queries/content (shared with
// the /admin/content DAL read); this route delegates to it.
// Errors use the admin-only envelope { error, code } via toEnvelope().
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  requireAdminFromSupabase,
  toEnvelope,
} from "@/lib/admin";
import { createQueryDeps } from "@/lib/admin-queries/shared";
import { queryContentStartups } from "@/lib/admin-queries/content";

export async function GET(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdminFromSupabase();
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }

  try {
    const deps = await createQueryDeps(admin);
    const url = new URL(request.url);
    const dto = await queryContentStartups(deps, {
      page: url.searchParams.get("page"),
      limit: url.searchParams.get("limit"),
      sort: url.searchParams.get("sort"),
      order: url.searchParams.get("order"),
      q: url.searchParams.get("q"),
      flagged: url.searchParams.get("flagged"),
      verdict: url.searchParams.get("verdict"),
      confidence: url.searchParams.get("confidence"),
    });
    return NextResponse.json(dto);
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}
