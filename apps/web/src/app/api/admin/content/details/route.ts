// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/content/details?startup_id= → full detail graph
// { startup, assumptions, evidence, decisions, traces } (spec §§2-3,7).
// Both tiers read through scopedQuery: platform via the service-role client
// filtered to the single startup id (+ `.not('workspace_id', 'is', null)`
// on child reads so NULL-workspace rows never mix in); workspace tier via
// the user client (RLS) + scopedQuery — the scoping predicate
// `.in('workspace_id', workspaceIds)` is appended inside scopedQuery, so an
// out-of-scope id yields 404 (no existence leak).
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
import { queryContentDetails } from "@/lib/admin-queries/content";

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
    const startupId = new URL(request.url).searchParams.get("startup_id");
    const deps = await createQueryDeps(admin);
    const dto = await queryContentDetails(deps, startupId);
    return NextResponse.json(dto);
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}
