// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/ops/limits → { window, severity, errorsByActor,
// rateLimited429, configured, truncated }. Delegates to queryOpsLimits
// (same helper the /admin/ops page reads directly).
// Severity is derived from trace_events over the window (?window=7d|30d|
// 90d, default 7d; custom capped at 90d via parseAdminWindow):
// error = event_type 'error'; warning = verification events carrying a
// warning/unsupported payload; info = everything else. rateLimited429
// counts events whose payload mentions a 429/rate-limit signal (documented
// heuristic — the agent route enforces its in-memory 10 req/min cap without
// persisting a row, so only surfaced signals are counted). `configured`
// echoes the compiled caps as a read-only reference (BUDGET from
// apps/web/src/lib/utils.ts — imported read-only, never modified — plus
// the agent route's per-IP request cap). Server cap (traces 10000) sets
// `truncated: true` when it binds. NULL-workspace rows EXCLUDED on the
// platform path; workspace path via user client (RLS) + scopedQuery.
// Matrix: platform full; workspace-tier member+ read scoped to own
// workspaces; viewers NONE at the gate. Errors use the admin-only
// envelope { error, code } via toEnvelope().
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  requireAdminFromSupabase,
  toEnvelope,
} from "@/lib/admin";
import { createQueryDeps } from "@/lib/admin-queries/shared";
import { queryOpsLimits } from "@/lib/admin-queries/ops";

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
    const rawWindow = new URL(request.url).searchParams.get("window");
    const deps = await createQueryDeps(admin);
    const dto = await queryOpsLimits(deps, rawWindow);
    return NextResponse.json(dto);
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}
