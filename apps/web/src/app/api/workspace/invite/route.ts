// ─────────────────────────────────────────────────────────────────────────────
// /api/workspace/invite — full invite lifecycle (Task 8, R1 hardened)
// GET    ?workspace_id=  → list invites (any workspace member; NEVER tokens)
// POST   {workspace_id, email, role} → create (owner/admin; dup 409; hashed)
// PATCH  {invite_id, action} → accept | decline | resend | revoke
// DELETE ?invite_id=      → revoke (owner/admin; REST alias of PATCH revoke)
//
// Security (R1):
// - Hash-only tokens: the raw token is NEVER persisted (DB `token` stays
//   NULL for new rows, migration 0005 makes it nullable) and never logged
//   or returned. Only sha256 token_hash is stored (NOT NULL for new writes
//   via the 0005 NOT VALID check; legacy NULL-hash rows accept via the same
//   email-match path and are backfilled on resend rotation).
// - Invitee RLS deadlock: 0004 RLS select/update are member-only, so a
//   non-member invitee cannot read/mutate their invite via the anon
//   PostgREST path. PATCH therefore reads/mutates the invite row via the
//   service_role client with EXPLICIT gates (auth-email match and/or
//   owner/admin + expiry + pending). RLS policies stay tight on purpose.
// - On-behalf accept is explicitly FORBIDDEN (403): only the invited email
//   address can accept; owners/admins cannot accept for someone else.
// Expiry is enforced on every mutation (stale pending → marked expired →
// 410); resend may refresh pending/expired. Workspace isolation: every
// path gates on workspace_members first.
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/supabase/server";
import { resolveInviteGate, type EntitlementStatus } from "@/lib/entitlements";
import { INVITE_TTL_MS, hashInviteToken as hashToken, isInviteExpired } from "@/lib/invites";
import { inviteActionSchema, inviteIdSchema, inviteListQuerySchema, inviteSchema } from "@/lib/validation";
import type { MemberRole } from "@/lib/types";

// Trial-paywall denial messages (402).
const INVITE_GATE_MESSAGES: Record<string, string> = {
  SUBSCRIPTION_REQUIRED: "الدعوات ميزة مدفوعة — اشترك لدعوة أعضاء",
  TRIAL_CONSUMED: "انتهت تجربتك المجانية — اشترك لفتح مشاريع جديدة",
  ACCOUNT_PAUSED: "حسابك موقوف مؤقتًا — راجع الإدارة",
};

// Columns safe to expose — token / token_hash deliberately excluded.
const PUBLIC_COLUMNS =
  "id,workspace_id,email,role,status,expires_at,invited_by,created_at";

const ROLE_RANK: Record<MemberRole, number> = { viewer: 1, member: 2, admin: 3, owner: 4 };

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

  // Trial paywall: invites are a paid feature — only subscribed/legacy
  // callers may create them (402). 401/403 guards above unchanged.
  // Service-role read: user_entitlements has no user-RLS read path.
  let createStatus: EntitlementStatus | null = "legacy";
  try {
    const { data: entitlement, error: entitlementError } = await createServiceRoleClient()
      .from("user_entitlements")
      .select("status")
      .eq("user_id", user.id)
      .maybeSingle();
    if (entitlementError) throw entitlementError;
    if (!entitlement) {
      console.warn("[invite] missing user_entitlements row, treating as legacy", { user_id: user.id });
    } else {
      const rawStatus = (entitlement as { status?: unknown }).status;
      createStatus = typeof rawStatus === "string" ? (rawStatus as EntitlementStatus) : "legacy";
    }
  } catch {
    return NextResponse.json({ error: "Entitlement check unavailable. Try again shortly." }, { status: 429 });
  }
  const createGate = resolveInviteGate(createStatus, "create");
  if (!createGate.allowed) {
    return NextResponse.json(
      {
        error: INVITE_GATE_MESSAGES[createGate.code] ?? INVITE_GATE_MESSAGES.SUBSCRIPTION_REQUIRED,
        code: createGate.code,
        plans_url: "/plans",
      },
      { status: 402 },
    );
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

  // Create invite record — R1 hash-only: the raw token exists only in
  // memory (never logged/stored/returned); only its sha256 is persisted
  // and `token` stays NULL (migration 0005 makes it nullable).
  const rawToken = randomUUID();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

  const { error: inviteError } = await supabase
    .from("workspace_invites")
    .insert({
      workspace_id,
      email,
      role,
      token: null,
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

  // R1 invitee path: the invite row is read/mutated via service_role.
  // Member-only RLS (0004) would hide the row from a non-member invitee
  // on the anon path, so every action below re-enforces its gate
  // explicitly (email match and/or owner/admin + expiry + pending).
  const service = createServiceRoleClient();
  const { data: invite } = await service
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
  if (isInviteExpired(row)) {
    if (!(action === "resend" && isPrivileged)) {
      await service.from("workspace_invites").update({ status: "expired" }).eq("id", invite_id);
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
        // Decline is invitee-or-privileged; service write is safe because
        // the gate above already enforced email match or owner/admin.
        const { error } = await service
          .from("workspace_invites")
          .update({ status: "declined" })
          .eq("id", invite_id);
        if (error) return NextResponse.json({ error: "Failed to decline invite" }, { status: 500 });
        return NextResponse.json({ success: true, status: "declined" });
      }
      // R1: on-behalf accept is explicitly forbidden (403, not 409).
      // Owner/admin callers are already workspace members, so without this
      // branch their accept would fall through to the 409 below and look
      // like an idempotency conflict. Only the invited email may accept.
      if (!emailMatch) {
        return NextResponse.json(
          { error: "Only the invited email address can accept this invite; owners/admins cannot accept on behalf" },
          { status: 403 },
        );
      }
      // accept: already a member → idempotent conflict, invite left untouched.
      if (role) {
        return NextResponse.json({ error: "Already a member of this workspace" }, { status: 409 });
      }
      // Trial paywall: the INVITEE's (user.id) entitlement gates the accept
      // (402). On-behalf/privileged/expiry/pending rules above unchanged.
      let acceptStatus: EntitlementStatus | null = "legacy";
      try {
        const { data: acceptEntitlement, error: acceptEntitlementError } = await service
          .from("user_entitlements")
          .select("status")
          .eq("user_id", user.id)
          .maybeSingle();
        if (acceptEntitlementError) throw acceptEntitlementError;
        if (!acceptEntitlement) {
          console.warn("[invite] missing user_entitlements row, treating as legacy", { user_id: user.id });
        } else {
          const rawAccept = (acceptEntitlement as { status?: unknown }).status;
          acceptStatus = typeof rawAccept === "string" ? (rawAccept as EntitlementStatus) : "legacy";
        }
      } catch {
        return NextResponse.json({ error: "Entitlement check unavailable. Try again shortly." }, { status: 429 });
      }
      const acceptGate = resolveInviteGate(acceptStatus, "accept");
      if (!acceptGate.allowed) {
        return NextResponse.json(
          {
            error: INVITE_GATE_MESSAGES[acceptGate.code] ?? INVITE_GATE_MESSAGES.SUBSCRIPTION_REQUIRED,
            code: acceptGate.code,
            plans_url: "/plans",
          },
          { status: 402 },
        );
      }
      // Service-role member insert: RLS members_insert is owner/admin-only
      // and the invitee is by definition not a member yet; the email +
      // pending + expiry gates above are the authorization for this write.
      const { error: memberError } = await service.from("workspace_members").insert({
        workspace_id: row.workspace_id,
        user_id: user.id,
        role: row.role,
      });
      if (memberError) {
        return NextResponse.json({ error: "Failed to accept invite" }, { status: 500 });
      }
      const { error: acceptError } = await service
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
      // Rotate token (hash-only, R1) + refresh expiry; invite stays pending.
      // This also backfills token_hash for legacy NULL-hash rows.
      // Never log the raw token — it is credential-equivalent.
      const rawToken = randomUUID();
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
      const { error } = await service
        .from("workspace_invites")
        .update({ token: null, token_hash: hashToken(rawToken), expires_at: expiresAt, status: "pending" })
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
      const { error } = await service
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
  if (!invite_id || !inviteIdSchema.safeParse(invite_id).success) {
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
  if (isInviteExpired(row)) {
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
