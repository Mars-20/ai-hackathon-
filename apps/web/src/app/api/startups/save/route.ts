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
import { startupSaveSchema } from "@/lib/validation";

function normId(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

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
  const rawIdInput = normId(s.id);
  const rawWorkspaceInput = normId(s.workspace_id);
  const rawStageInput = normId(s.stage);
  const rawDomainInput = typeof s.domain === "string" ? s.domain : undefined;

  const parsed = startupSaveSchema.safeParse({
    id: rawIdInput,
    name: s.name,
    stage: rawStageInput,
    domain: rawDomainInput,
    workspace_id: rawWorkspaceInput,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  const rawId = parsed.data.id ?? crypto.randomUUID();
  const clientSuppliedId = rawIdInput !== undefined;
  const rawWorkspaceId = parsed.data.workspace_id ?? null;

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

  // Owner fallback: when workspace_id is absent (personal startup), isolation
  // relies on owner_id === auth user. When a client-supplied id targets an
  // existing row, verify the caller owns it or is a member of its workspace
  // so one user cannot hijack another's startup via guessed UUID.
  if (clientSuppliedId) {
    const { data: existing } = await supabase
      .from("startups")
      .select("id, owner_id, workspace_id")
      .eq("id", rawId)
      .maybeSingle();
    if (existing) {
      const typed = existing as { owner_id: string; workspace_id: string | null };
      if (typed.owner_id !== user.id) {
        if (!typed.workspace_id) {
          return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
        const { data: m } = await supabase
          .from("workspace_members")
          .select("workspace_id")
          .eq("workspace_id", typed.workspace_id)
          .eq("user_id", user.id)
          .maybeSingle();
        if (!m) {
          return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
      }
    }
  }

  const row = {
    id: rawId,
    workspace_id: rawWorkspaceId,
    owner_id: user.id,
    name: parsed.data.name,
    one_liner: typeof s.one_liner === "string" ? s.one_liner : "",
    domain: parsed.data.domain?.trim() ? parsed.data.domain.trim() : "general",
    target_customer:
      typeof s.target_customer === "string" && s.target_customer.trim()
        ? s.target_customer
        : null,
    stage: parsed.data.stage,
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
    console.error("[Save API] Failed to save startup");
    return NextResponse.json({ error: "Failed to save startup" }, { status: 500 });
  }

  return NextResponse.json({ startup: data });
}
