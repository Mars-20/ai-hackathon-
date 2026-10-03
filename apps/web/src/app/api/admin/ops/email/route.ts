// ─────────────────────────────────────────────────────────────────────────────
// /api/admin/ops/email (Task 5 ops module).
// GET → { pending, total, truncated }: pending workspace_invites
// (status='pending') — the v1 email queue. Invite tokens are NEVER
// selected or returned (token = credential-equivalent).
// POST { invite_id, reason? } → resend: PLATFORM-TIER ONLY. The resend is
// recorded audit-atomically through the `admin_action` RPC
// (`email_resend` branch); v1 wires no mailer (spec §9 non-goal — same
// posture as POST /api/workspace/invite), so success means "resend
// recorded, delivery out of scope" (see `note` in the response).
// Workspace-tier callers get the Task-4 PATCH deny-trail pattern: the
// route still calls `admin_action`/`email_resend` from the user client
// first (the RPC commits the denied/forbidden trail per spec §6), then
// returns the stable 403 envelope. This fast-guard pattern applies to any
// new privileged RPC guard — including future settings_* writes, which
// have no v1 write path (workspace tier has no settings write path per
// spec §5). Matrix: platform full; workspace-tier member+ GET read;
// POST resend platform-only; viewers NONE at the requireAdmin gate.
// Errors use the admin-only envelope { error, code } via toEnvelope().
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireAdminFromSupabase, scopedAdminQuery, toEnvelope } from "@/lib/admin";
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from "@/lib/supabase/server";

// Invite token deliberately excluded — credential-equivalent.
const PENDING_COLUMNS =
  "id,workspace_id,email,role,status,expires_at,invited_by,created_at";
const PENDING_CAP = 1000;

interface PendingInvite {
  id: string;
  workspace_id: string;
  email: string;
  role: string;
  status: string;
  expires_at: string | null;
  invited_by: string | null;
  created_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asPendingInvites(value: unknown): PendingInvite[] {
  if (!Array.isArray(value)) return [];
  const out: PendingInvite[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (
      typeof item["id"] !== "string" ||
      typeof item["workspace_id"] !== "string" ||
      typeof item["email"] !== "string" ||
      typeof item["created_at"] !== "string"
    ) {
      continue;
    }
    const expires = item["expires_at"];
    const invitedBy = item["invited_by"];
    out.push({
      id: item["id"] as string,
      workspace_id: item["workspace_id"] as string,
      email: item["email"] as string,
      role: typeof item["role"] === "string" ? item["role"] : "",
      status: typeof item["status"] === "string" ? item["status"] : "",
      expires_at: typeof expires === "string" ? expires : null,
      invited_by: typeof invitedBy === "string" ? invitedBy : null,
      created_at: item["created_at"] as string,
    });
  }
  return out;
}

function rpcDenyToStatus(errorCode: string): number {
  switch (errorCode) {
    case "not_authenticated":
      return 401;
    case "forbidden":
      return 403;
    case "invite_not_found":
      return 404;
    case "invalid_invite_id":
    case "invite_not_pending":
    case "unknown_action":
      return 400;
    default:
      return 400;
  }
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
    let pending: PendingInvite[];
    if (admin.tier === "platform") {
      const service = createServiceRoleClient();
      const { data, error } = await service
        .from("workspace_invites")
        .select(PENDING_COLUMNS)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(PENDING_CAP);
      if (error) throw error;
      pending = asPendingInvites(data);
    } else {
      // Workspace tier: user client (RLS) + scopedQuery — the scoping
      // predicate `.in('workspace_id', workspaceIds)` is appended inside
      // scopedQuery (single DB round-trip).
      const userClient = await createServerSupabaseClient();
      const rowsUnknown: unknown = await scopedAdminQuery(
        userClient,
        "workspace_invites",
        admin.workspaceIds,
        (q) =>
          q
            .select(PENDING_COLUMNS)
            .eq("status", "pending")
            .order("created_at", { ascending: false })
            .limit(PENDING_CAP),
      );
      pending = asPendingInvites(rowsUnknown);
    }
    return NextResponse.json({
      pending,
      total: pending.length,
      truncated: pending.length >= PENDING_CAP,
    });
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}

export async function POST(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdminFromSupabase();
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }

  try {
    const body: unknown = await request.json().catch(() => null);
    const inviteId =
      isRecord(body) && typeof body["invite_id"] === "string"
        ? (body["invite_id"] as string)
        : null;
    const reason =
      isRecord(body) && typeof body["reason"] === "string"
        ? (body["reason"] as string)
        : null;

    // Platform-tier only: workspace-tier POST is denied with a committed
    // `denied` trail (Task-4 PATCH pattern — spec §6 every-mutation-trail).
    // The RPC is authoritative for the trail: non-platform callers still
    // route through `admin_action`/`email_resend` from the user client
    // (which returns {ok:false,error:"forbidden"} and commits the denied
    // row), then the route returns the stable 403 envelope below.
    if (admin.tier !== "platform") {
      try {
        const trailClient = await createServerSupabaseClient();
        await trailClient.rpc("admin_action", {
          action: "email_resend",
          target: { invite_id: inviteId },
          payload: {},
          reason,
        });
      } catch {
        // Best-effort trail: a trail failure must not mask the 403.
      }
      return NextResponse.json(
        { error: "Email resend is platform-managed", code: "FORBIDDEN" },
        { status: 403 },
      );
    }

    if (!inviteId || inviteId.length === 0) {
      return NextResponse.json(
        { error: "invite_id is required", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }

    // Privileged path: single-transaction `admin_action` RPC
    // (`email_resend`) so the audit row and the resend record commit
    // atomically (two-client pattern forbidden here).
    const userClient = await createServerSupabaseClient();
    const { data, error } = await userClient.rpc("admin_action", {
      action: "email_resend",
      target: { invite_id: inviteId },
      payload: {},
      reason,
    });
    if (error) throw error;
    if (isRecord(data) && data["ok"] === false) {
      const code = typeof data["error"] === "string" ? data["error"] : "unknown";
      return NextResponse.json(
        { error: code, code: code.toUpperCase() },
        { status: rpcDenyToStatus(code) },
      );
    }
    return NextResponse.json({
      ok: true,
      resent: inviteId,
      note: "Resend recorded in audit_log; mail delivery is out of scope in v1 (spec §9).",
    });
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}
