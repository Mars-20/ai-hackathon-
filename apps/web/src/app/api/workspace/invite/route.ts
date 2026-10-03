// ─────────────────────────────────────────────────────────────────────────────
// /api/workspace/invite — full invite lifecycle (Task 8)
// GET    ?workspace_id=  → list invites (any workspace member; NEVER tokens)
// POST   {workspace_id, email, role} → create (owner/admin; dup 409; hashed)
// PATCH  {invite_id, action} → accept | decline | resend | revoke
// DELETE ?invite_id=      → revoke (owner/admin; REST alias of PATCH revoke)
//
// Security: invite tokens are credential-equivalent — stored as sha256
// token_hash (migration 0004) plus the legacy token column, never logged and
// never returned by any handler. Expiry is enforced on every mutation
// (stale pending → marked expired → 410); resend may refresh pending/expired.
// Workspace isolation: every path gates on workspace_members first.
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { INVITE_TTL_MS, hashInviteToken as hashToken } from "@/lib/invites";
import { inviteActionSchema, inviteListQuerySchema, inviteSchema } from "@/lib/validation";
import type { MemberRole } from "@/lib/types";

// Columns safe to expose — token / token_hash deliberately excluded.
const PUBLIC_COLUMNS =
  "id,workspace_id,email,role,status,expires_at,invited_by,created_at";

const ROLE_RANK: Record<MemberRole, number> = { viewer: 1, member: 2, admin: 3, owner: 4 };

function isExpiredLike(invite: { status: string; expires_at: string }): boolean {
  return (
    invite.status === "expired" ||
    (invite.status === "pending" && new Date(invite.expires_at).getTime() <= Date.now())
  );
}

async function callerRole(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  workspaceId: string,
  userId: string,
): Promise<MemberRole | null> {
  const { data } = await supabase
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  const role = (data as { role?: unknown } | null)?.role;
  return typeof role === "string" ? (role as MemberRole) : null;
}

// ── GET: list ────────────────────────────────────────────────────────────────
export async function GET(request: NextRequest) {
  const supabase = await createServerSupabaseClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = inviteListQuerySchema.safeParse({
    workspace_id: request.nextUrl.searchParams.get("workspace_id"),
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }
  const { workspace_id } = parsed.data;

  const role = await callerRole(supabase, workspace_id, user.id);
  if (!role) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  const { data, error } = await supabase
    .from("workspace_invites")
    .select(PUBLIC_COLUMNS)
    .eq("workspace_id", workspace_id)
    .order("created_at", { ascending: false });
  if (error) {
    return NextResponse.json({ error: "Failed to list invites" }, { status: 500 });
  }

  // Explicit pick (defense in depth: token material never leaves the server
  // even if the select above is widened later) + derived expiry flag.
  const invites = ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    id: row["id"],
    workspace_id: row["workspace_id"],
    email: row["email"],
    role: row["role"],
    status: row["status"],
    expires_at: row["expires_at"],
    invited_by: row["invited_by"],
    created_at: row["created_at"],
    is_expired:
      row["status"] === "expired" ||
      (row["status"] === "pending" &&
        new Date(String(row["expires_at"])).getTime() <= Date.now()),
  }));
  return NextResponse.json({ invites });
}

// ── POST: create ─────────────────────────────────────────────────────────────
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
  const workspace_id = parsed.data.workspace_id;
  const email = parsed.data.email.trim().toLowerCase();
  const role = parsed.data.role;

  // Verify caller has permission to invite (must be owner or admin)
  const callerRoleValue = await callerRole(supabase, workspace_id, user.id);

  if (!callerRoleValue || !["owner", "admin"].includes(callerRoleValue)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  // Cannot invite someone with higher permissions than yourself
  if (ROLE_RANK[role] > ROLE_RANK[callerRoleValue]) {
    return NextResponse.json({ error: "Cannot assign a role higher than your own" }, { status: 403 });
  }

  // Duplicate guard: pending invite already exists for this email+workspace.
  // Decided/expired invites do NOT block a fresh re-invite.
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

  // Create invite record — raw token hashed (sha256) before storage.
  const rawToken = randomUUID();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

  const { error: inviteError } = await supabase
    .from("workspace_invites")
    .insert({
      workspace_id,
      email,
      role,
      token: rawToken,
      token_hash: hashToken(rawToken),
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
    invite: { workspace_id, email, role, status: "pending", expires_at: expiresAt },
  });
}

// ── PATCH: accept / decline / resend / revoke ────────────────────────────────
export async function PATCH(request: NextRequest) {
  const supabase = await createServerSupabaseClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const parsed = inviteActionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }
  const { invite_id, action } = parsed.data;

  const { data: invite } = await supabase
    .from("workspace_invites")
    .select("id,workspace_id,email,role,status,expires_at")
    .eq("id", invite_id)
    .maybeSingle();
  if (!invite) {
    return NextResponse.json({ error: "Invite not found" }, { status: 404 });
  }
  const row = invite as { workspace_id: string; email: string; role: MemberRole; status: string; expires_at: string };
  const role = await callerRole(supabase, row.workspace_id, user.id);
  const isPrivileged = role === "owner" || role === "admin";

  // Expiry enforcement: stale pending invites are marked expired and every
  // action except a privileged resend is rejected with 410.
  if (isExpiredLike(row)) {
    if (!(action === "resend" && isPrivileged)) {
      await supabase.from("workspace_invites").update({ status: "expired" }).eq("id", invite_id);
      return NextResponse.json({ error: "Invite expired" }, { status: 410 });
    }
  }

  switch (action) {
    case "accept":
    case "decline": {
      const emailMatch =
        typeof user.email === "string" && user.email.toLowerCase() === row.email.toLowerCase();
      if (!emailMatch && !isPrivileged) {
        return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
      }
      if (row.status !== "pending") {
        return NextResponse.json({ error: "Invite is no longer pending" }, { status: 400 });
      }
      if (action === "decline") {
        const { error } = await supabase
          .from("workspace_invites")
          .update({ status: "declined" })
          .eq("id", invite_id);
        if (error) return NextResponse.json({ error: "Failed to decline invite" }, { status: 500 });
        return NextResponse.json({ success: true, status: "declined" });
      }
      // accept: already a member → idempotent conflict, invite left untouched.
      if (role) {
        return NextResponse.json({ error: "Already a member of this workspace" }, { status: 409 });
      }
      const { error: memberError } = await supabase.from("workspace_members").insert({
        workspace_id: row.workspace_id,
        user_id: user.id,
        role: row.role,
      });
      if (memberError) {
        return NextResponse.json({ error: "Failed to accept invite" }, { status: 500 });
      }
      const { error: acceptError } = await supabase
        .from("workspace_invites")
        .update({ status: "accepted" })
        .eq("id", invite_id);
      if (acceptError) {
        return NextResponse.json({ error: "Failed to accept invite" }, { status: 500 });
      }
      return NextResponse.json({ success: true, status: "accepted" });
    }
    case "resend": {
      if (!isPrivileged) {
        return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
      }
      if (row.status !== "pending" && row.status !== "expired") {
        return NextResponse.json({ error: "Only pending invites can be resent" }, { status: 400 });
      }
      // Rotate token + refresh expiry; invite stays pending.
      // Never log the raw token — it is credential-equivalent.
      const rawToken = randomUUID();
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
      const { error } = await supabase
        .from("workspace_invites")
        .update({ token: rawToken, token_hash: hashToken(rawToken), expires_at: expiresAt, status: "pending" })
        .eq("id", invite_id);
      if (error) {
        return NextResponse.json({ error: "Failed to resend invite" }, { status: 500 });
      }
      // NOTE: mail delivery out of scope in v1 (same posture as POST).
      return NextResponse.json({ success: true, status: "pending", expires_at: expiresAt });
    }
    case "revoke": {
      if (!isPrivileged) {
        return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
      }
      if (row.status !== "pending") {
        return NextResponse.json({ error: "Only pending invites can be revoked" }, { status: 400 });
      }
      const { error } = await supabase
        .from("workspace_invites")
        .update({ status: "revoked" })
        .eq("id", invite_id);
      if (error) {
        return NextResponse.json({ error: "Failed to revoke invite" }, { status: 500 });
      }
      return NextResponse.json({ success: true, status: "revoked" });
    }
  }
}

// ── DELETE: revoke (REST alias) ──────────────────────────────────────────────
export async function DELETE(request: NextRequest) {
  const supabase = await createServerSupabaseClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const invite_id = request.nextUrl.searchParams.get("invite_id");
  if (!invite_id || !z.string().uuid().safeParse(invite_id).success) {
    return NextResponse.json({ error: "invite_id is required" }, { status: 400 });
  }

  const { data: invite } = await supabase
    .from("workspace_invites")
    .select("id,workspace_id,status,expires_at")
    .eq("id", invite_id)
    .maybeSingle();
  if (!invite) {
    return NextResponse.json({ error: "Invite not found" }, { status: 404 });
  }
  const row = invite as { workspace_id: string; status: string; expires_at: string };
  const role = await callerRole(supabase, row.workspace_id, user.id);
  if (role !== "owner" && role !== "admin") {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }
  if (isExpiredLike(row)) {
    await supabase.from("workspace_invites").update({ status: "expired" }).eq("id", invite_id);
    return NextResponse.json({ error: "Invite expired" }, { status: 410 });
  }
  if (row.status !== "pending") {
    return NextResponse.json({ error: "Only pending invites can be revoked" }, { status: 400 });
  }
  const { error } = await supabase
    .from("workspace_invites")
    .update({ status: "revoked" })
    .eq("id", invite_id);
  if (error) {
    return NextResponse.json({ error: "Failed to revoke invite" }, { status: 500 });
  }
  return NextResponse.json({ success: true, status: "revoked" });
}
