// ─────────────────────────────────────────────────────────────────────────────
// POST /api/workspace/invite
// Sends an invite to a new team member for a workspace
// Requires: caller must be owner or admin of the workspace
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { MemberRole } from "@/lib/types";

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient();

  // Verify caller is authenticated
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { workspace_id, email, role } = body as {
    workspace_id: string;
    email: string;
    role: MemberRole;
  };

  if (!workspace_id || !email || !role) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

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
    console.error("Invite insert error:", inviteError);
    return NextResponse.json({ error: "Failed to create invite" }, { status: 500 });
  }

  // TODO: In production, send email via Resend/SendGrid with invite link:
  // const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL}/invite/${token}`;
  // await sendInviteEmail({ to: email, inviteUrl, workspaceName, inviterName });

  console.log(`[Workspace Invite] ${email} invited to workspace ${workspace_id} as ${role}`);
  console.log(`[Invite Link] ${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/invite/${token}`);

  return NextResponse.json({
    success: true,
    message: `Invite sent to ${email}`,
    // Return token in dev for testing — remove in production
    ...(process.env.NODE_ENV === "development" && { debug_token: token }),
  });
}
