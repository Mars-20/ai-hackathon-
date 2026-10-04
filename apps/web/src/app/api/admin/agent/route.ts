// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/agent → agent settings READ view (Task 5). Delegates to
// queryAgentSettings (same helper the /admin/ops page reads directly).
// Returns the same JSON shape as the public-equivalent settings read:
// the full `admin_settings` key/value map with per-key updated_at —
// operational knobs only (cap, timeout, rate-limit ranges per spec §5).
// No secret materialization: this route never returns auth keys, service
// role material, or tokens — `admin_settings` holds non-secret operational
// config, and only key/value/updated_at columns are selected. Read-only:
// no PUT/POST path exists in v1 (spec §5 write path deferred; workspace
// tier has no settings write path). Both tiers read the identical global
// map via the service-role client (documented global-knobs exception —
// admin_settings has no workspace_id to scope on and RLS permits only
// platform selects, so a user-client read would return nothing for the
// workspace tier). Matrix: platform full; workspace-tier member+ read;
// viewers get NONE at the requireAdmin gate. Errors use the admin-only
// envelope { error, code } via toEnvelope().
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse } from "next/server";
import { requireAdminFromSupabase, toEnvelope } from "@/lib/admin";
import { createQueryDeps } from "@/lib/admin-queries/shared";
import { queryAgentSettings } from "@/lib/admin-queries/ops";

export async function GET() {
  let admin;
  try {
    admin = await requireAdminFromSupabase();
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }

  try {
    const deps = await createQueryDeps(admin);
    const dto = await queryAgentSettings(deps);
    return NextResponse.json(dto);
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}
