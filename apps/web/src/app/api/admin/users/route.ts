// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/users → { users, total, pages, page, limit } (spec §§2-4).
// Rows sourced from `profiles` (email, created_at) LEFT JOIN
// `workspace_members`, plus live status from the Auth Admin API
// (`banned_until`: banned => "suspended", else "active").
// Email search is a prefix match on `profiles.email` (trigram index) via the
// canonical escapePostgrest(); sortable columns allowlist: email, created_at.
// Platform tier reads all rows via the service-role client. Workspace tier
// discovers scope through the user client (RLS) + scopedQuery — the scoping
// predicate `.in('workspace_id', workspaceIds)` is appended inside
// scopedQuery — then reads profiles via service-role FILTERED to the
// in-scope user ids only (documented profiles-PII exception in
// packages/db/admin-migration.sql: RLS permits own-row + platform-full, so
// cross-user workspace reads must use the filtered service-role path and
// return in-scope rows only). Errors use { error, code } via toEnvelope().
// Query implementation lives in @/lib/admin-queries/users (shared with the
// /admin/users DAL read); this route delegates to it.
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  requireAdminFromSupabase,
  toEnvelope,
} from "@/lib/admin";
import { createQueryDeps } from "@/lib/admin-queries/shared";
import { queryUsersList } from "@/lib/admin-queries/users";

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
    const dto = await queryUsersList(deps, {
      page: url.searchParams.get("page"),
      limit: url.searchParams.get("limit"),
      sort: url.searchParams.get("sort"),
      order: url.searchParams.get("order"),
      q: url.searchParams.get("q"),
    });
    return NextResponse.json(dto);
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}
