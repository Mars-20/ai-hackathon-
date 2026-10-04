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
import { requireAdminFromSupabase, toEnvelope } from "@/lib/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createQueryDeps } from "@/lib/admin-queries/shared";
import { queryOpsEmail } from "@/lib/admin-queries/ops";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
    const deps = await createQueryDeps(admin);
    const dto = await queryOpsEmail(deps);
    return NextResponse.json(dto);
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
