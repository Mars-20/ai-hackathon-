// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/agent → agent settings READ view (Task 5).
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
import { createServiceRoleClient } from "@/lib/supabase/server";

const SETTINGS_CAP = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface SettingEntry {
  value: unknown;
  updated_at: string | null;
}

export async function GET() {
  let admin;
  try {
    admin = await requireAdminFromSupabase();
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }

  try {
    const service = createServiceRoleClient();
    const { data, error } = await service
      .from("admin_settings")
      .select("key,value,updated_at")
      .order("key", { ascending: true })
      .limit(SETTINGS_CAP);
    if (error) throw error;

    const settings: Record<string, SettingEntry> = {};
    let truncated = false;
    if (Array.isArray(data)) {
      if (data.length >= SETTINGS_CAP) truncated = true;
      for (const row of data) {
        if (!isRecord(row)) continue;
        if (typeof row["key"] !== "string") continue;
        const updated = row["updated_at"];
        settings[row["key"] as string] = {
          value: row["value"] ?? null,
          updated_at: typeof updated === "string" ? updated : null,
        };
      }
    }

    return NextResponse.json({
      settings,
      meta: {
        source: "admin_settings",
        readOnly: true,
        tier: admin.tier,
        fetched_at: new Date().toISOString(),
      },
      truncated,
    });
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}
