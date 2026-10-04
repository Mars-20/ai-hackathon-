// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/ops/audit → { entries, total, pages, page, limit }
// (Task 5 ops module). Delegates to queryOpsAudit (same helper the
// /admin/ops page reads directly). Actor/action exact-match filters
// (?actor=uuid, ?action=...), newest-first, paginated via getPagination
// (defaults page 20 / max 100). Only safe audit_log columns are selected
// (id, actor, action, target, reason, diff, workspace_id, result,
// created_at) — no stack traces or server internals are ever returned;
// failures normalize through toEnvelope() (no stacks leak).
// Scoping: platform tier reads all rows via the service-role client;
// workspace tier requires admin/owner (S7-strict, spec §7 "audit read-only
// for admin/owner"): workspace-tier members (role viewer OR member) get 403
// { error, code: "FORBIDDEN" } via the ROLE_RANK max-own guard inside the
// helper (mirrors content/screen/route.ts rank >= 3 style). Eligible
// workspace reads go through the USER client (RLS) + scopedQuery, so
// the `.in('workspace_id', workspaceIds)` predicate plus the owner/admin
// audit RLS policy jointly govern visibility. NULL-workspace rows (platform
// actions) are visible to platform only. Matrix: platform full;
// workspace-tier admin/owner read; viewers NONE at the requireAdmin gate,
// members 403 at the helper guard. Errors use the
// admin-only envelope { error, code } via toEnvelope().
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  requireAdminFromSupabase,
  toEnvelope,
} from "@/lib/admin";
import { createQueryDeps } from "@/lib/admin-queries/shared";
import { queryOpsAudit } from "@/lib/admin-queries/ops";

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
    const params = new URL(request.url).searchParams;
    const deps = await createQueryDeps(admin);
    const dto = await queryOpsAudit(deps, {
      page: params.get("page"),
      limit: params.get("limit"),
      actor: params.get("actor"),
      action: params.get("action"),
    });
    return NextResponse.json(dto);
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}
