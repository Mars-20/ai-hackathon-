// ─────────────────────────────────────────────────────────────────────────────
// POST /api/workspace/invite
// Sends an invite to a new team member for a workspace
// Requires: caller must be owner or admin of the workspace
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { inviteSchema } from "@/lib/validation";
import type { MemberRole } from "@/lib/types";

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient();

  // Verify caller is authenticated
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const parsed = inviteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }
  const { workspace_id, email, role } = parsed.data;

  // Verify caller has permission to invite (must be owner or admin)
  const { data: callerMembership } = await supabase
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspace_id)
    .eq("user_id", user.id)
    .single();

  if (!callerMembership || !["owner", "admin"].includes(callerMembership.role)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  // Cannot invite someone with higher permissions than yourself
  const ROLE_RANK: Record<MemberRole, number> = { viewer: 1, member: 2, admin: 3, owner: 4 };
  if (ROLE_RANK[role] > ROLE_RANK[callerMembership.role as MemberRole]) {
    return NextResponse.json({ error: "Cannot assign a role higher than your own" }, { status: 403 });
  }

  // Duplicate guard: pending invite already exists for this email+workspace
  const { data: existingInvite } = await supabase
    .from("workspace_invites")
    .select("id")
    .eq("workspace_id", workspace_id)
    .eq("email", email)
    .eq("status", "pending")
    .maybeSingle();
  if (existingInvite) {
    return NextResponse.json({ error: "Pending invite already exists for this email" }, { status: 409 });
  }

  // Create invite record
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

  const { error: inviteError } = await supabase
    .from("workspace_invites")
    .insert({
      workspace_id,
      email,
      role,
      token,
      status: "pending",
      expires_at: expiresAt,
      invited_by: user.id,
    });

  if (inviteError) {
    console.error("Invite insert failed for workspace:", workspace_id);
    return NextResponse.json({ error: "Failed to create invite" }, { status: 500 });
  }

  // NOTE: Email delivery via Resend/SendGrid is out of scope for this change (see Task 8).
  // Never log invite tokens — they are credential-equivalent.

  return NextResponse.json({
    success: true,
    message: `Invite sent to ${email}`,
  });
}
