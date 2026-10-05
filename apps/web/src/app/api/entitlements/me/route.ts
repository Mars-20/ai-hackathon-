// ─────────────────────────────────────────────────────────────────────────────
// /api/entitlements/me — entitlement readout for the paywall UI (Task 6)
// GET → 200 {status, plan, trial_startup_id, frozen_startup_ids}
// Missing user_entitlements row → legacy defensive default
// ({status:"legacy", plan:"free", trial_startup_id:null, frozen_startup_ids:[]}).
// Reads go through the USER client (RLS entitlements_select_own + startups
// owner isolation); no PII is returned or logged by this endpoint.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function GET(_request?: NextRequest) {
  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: entitlement, error: entError } = await supabase
    .from("user_entitlements")
    .select("status,plan,trial_startup_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (entError) {
    return NextResponse.json({ error: "Failed to load entitlement" }, { status: 500 });
  }

  const { data: frozen, error: frozenError } = await supabase
    .from("startups")
    .select("id")
    .eq("owner_id", user.id)
    .eq("is_frozen", true);
  if (frozenError) {
    return NextResponse.json({ error: "Failed to load entitlement" }, { status: 500 });
  }

  const frozenIds = ((frozen ?? []) as Array<{ id: unknown }>)
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string");

  if (!entitlement) {
    return NextResponse.json({
      status: "legacy",
      plan: "free",
      trial_startup_id: null,
      frozen_startup_ids: frozenIds,
    });
  }

  const row = entitlement as {
    status: unknown;
    plan: unknown;
    trial_startup_id: unknown;
  };
  return NextResponse.json({
    status: row.status,
    plan: row.plan,
    trial_startup_id: row.trial_startup_id ?? null,
    frozen_startup_ids: frozenIds,
  });
}
