// ─────────────────────────────────────────────────────────────────────────────
// POST /api/startups/save
// Persists a validate-page startup snapshot for the authenticated user.
// Body: { startup: { id?, workspace_id?, name, one_liner, domain,
//   target_customer?, stage, business_model? } }
// Returns: { startup } on success.
// Client keeps its localStorage fallback intact on non-OK/404/network failure.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { startup?: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const s = body.startup ?? {};
  const name = typeof s.name === "string" ? s.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "startup.name is required" }, { status: 400 });
  }

  const rawId = typeof s.id === "string" && UUID_RE.test(s.id.trim()) ? s.id.trim() : crypto.randomUUID();
  const rawWorkspaceId =
    typeof s.workspace_id === "string" && UUID_RE.test(s.workspace_id.trim())
      ? s.workspace_id.trim()
      : null;

  // Membership gate: reject any workspace_id the caller is not a member of.
  if (rawWorkspaceId) {
    const { data: membership } = await supabase
      .from("workspace_members")
      .select("workspace_id")
      .eq("workspace_id", rawWorkspaceId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!membership) {
      return NextResponse.json({ error: "Forbidden: not a workspace member" }, { status: 403 });
    }
  }

  const row = {
    id: rawId,
    workspace_id: rawWorkspaceId,
    owner_id: user.id,
    name,
    one_liner: typeof s.one_liner === "string" ? s.one_liner : "",
    domain: typeof s.domain === "string" && s.domain.trim() ? s.domain : "general",
    target_customer:
      typeof s.target_customer === "string" && s.target_customer.trim()
        ? s.target_customer
        : null,
    stage: typeof s.stage === "string" && s.stage.trim() ? s.stage : "idea",
    business_model:
      typeof s.business_model === "string" && s.business_model.trim()
        ? s.business_model
        : null,
  };

  const { data, error } = await supabase
    .from("startups")
    .upsert(row, { onConflict: "id" })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message ?? "Failed to save startup" }, { status: 500 });
  }

  return NextResponse.json({ startup: data });
}
