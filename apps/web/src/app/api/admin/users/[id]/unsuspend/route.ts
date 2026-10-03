// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/users/[id]/unsuspend (spec §4 — verified against installed
// SDK @supabase/supabase-js@^2.50.0: auth.admin.updateUserById(id,
// { ban_duration: 'none' }) lifts the ban; `banned_until` is read-only).
// Privileged + audit-atomic via the `admin_action` RPC (same pattern as
// suspend). Errors use { error, code } via toEnvelope().
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireAdminFromSupabase, toEnvelope } from "@/lib/admin";
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from "@/lib/supabase/server";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  // Auth gate only — the binding is unused; the await still enforces
  // requireAdmin (401/403) before any privileged work below.
  try {
    await requireAdminFromSupabase();
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
  const { id } = await context.params;

  try {
    const body: unknown = await request.json().catch(() => null);
    const reason =
      isRecord(body) && typeof body["reason"] === "string"
        ? (body["reason"] as string)
        : null;

    const service = createServiceRoleClient();
    const { data: target } = await service.auth.admin.getUserById(id);
    if (!isRecord(target) || !isRecord(target["user"])) {
      return NextResponse.json(
        { error: "User not found", code: "NOT_FOUND" },
        { status: 404 },
      );
    }

    // Audit-atomic authorization via the `admin_action` RPC.
    const userClient = await createServerSupabaseClient();
    const { data: rpcData, error: rpcError } = await userClient.rpc(
      "admin_action",
      {
        action: "unsuspend",
        target: { user_id: id },
        payload: { ban_duration: "none" },
        reason,
      },
    );
    if (rpcError) throw rpcError;
    if (isRecord(rpcData) && rpcData["ok"] === false) {
      const code =
        typeof rpcData["error"] === "string" ? rpcData["error"] : "unknown";
      if (code === "forbidden") {
        return NextResponse.json(
          { error: "Insufficient permissions", code: "FORBIDDEN" },
          { status: 403 },
        );
      }
      return NextResponse.json(
        { error: code, code: code.toUpperCase() },
        { status: 400 },
      );
    }

    const { error: banError } = await service.auth.admin.updateUserById(id, {
      ban_duration: "none",
    });
    if (banError) throw banError;

    // Reconcile note (T3-I1 follow-up): same after-commit split as
    // suspend — the audit row committed in the RPC, the Auth lift applies
    // after (failures still throw above; atomicity UNCHANGED). Re-read and
    // report observed state so callers can retry safely.
    let reconcileNote = "ban_lift_unverified";
    try {
      const { data: reconciled } = await service.auth.admin.getUserById(id);
      const stillBanned =
        isRecord(reconciled) &&
        isRecord(reconciled["user"]) &&
        typeof reconciled["user"]["banned_until"] === "string" &&
        (reconciled["user"]["banned_until"] as string).length > 0;
      reconcileNote = stillBanned
        ? "ban_lift_pending_retry_safe"
        : "ban_lifted_verified";
    } catch {
      reconcileNote = "ban_lift_unverified";
    }

    return NextResponse.json({
      ok: true,
      unsuspended: id,
      reconcile_note: reconcileNote,
    });
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}
