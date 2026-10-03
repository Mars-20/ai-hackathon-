// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/users/[id]/suspend (spec §4 — verified against installed
// SDK @supabase/supabase-js@^2.50.0: auth.admin.updateUserById(id,
// { ban_duration: '8760h' }) suspends for 1 year).
// Privileged + audit-atomic: authorization + audit row commit inside the
// single-transaction `admin_action` RPC first; the Auth ban applies after.
// Guards: self-suspend 400; suspending the last platform admin 409;
// user-not-found 404. Errors use { error, code } via toEnvelope().
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
  let admin;
  try {
    admin = await requireAdminFromSupabase();
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
  const { id } = await context.params;

  try {
    if (id === admin.user.id) {
      return NextResponse.json(
        { error: "Cannot suspend your own account", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }

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

    // Audit-atomic authorization via the `admin_action` RPC: the audit row
    // commits in the same transaction; denies return { ok: false } with the
    // trail preserved (no orphan privileged change).
    const userClient = await createServerSupabaseClient();
    const { data: rpcData, error: rpcError } = await userClient.rpc(
      "admin_action",
      {
        action: "suspend",
        target: { user_id: id },
        payload: { ban_duration: "8760h" },
        reason,
      },
    );
    if (rpcError) throw rpcError;
    if (isRecord(rpcData) && rpcData["ok"] === false) {
      const code =
        typeof rpcData["error"] === "string" ? rpcData["error"] : "unknown";
      if (code === "cannot_suspend_self") {
        return NextResponse.json(
          { error: "Cannot suspend your own account", code: "BAD_REQUEST" },
          { status: 400 },
        );
      }
      if (code === "last_platform_admin") {
        return NextResponse.json(
          { error: "Cannot suspend the last platform admin", code: "CONFLICT" },
          { status: 409 },
        );
      }
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
      ban_duration: "8760h",
    });
    if (banError) throw banError;

    // Reconcile note (T3-I1 follow-up): the audit row committed inside the
    // RPC above, but the Auth ban applies after-commit — a ban failure
    // would leave audit-ok with the ban unapplied (still thrown above, so
    // atomicity is UNCHANGED here). Re-read the user and report the
    // observed state so callers can retry safely: an already-suspended
    // user reconciles to ok rather than erroring.
    let reconcileNote = "ban_applied_unverified";
    try {
      const { data: reconciled } = await service.auth.admin.getUserById(id);
      const banned =
        isRecord(reconciled) &&
        isRecord(reconciled["user"]) &&
        typeof reconciled["user"]["banned_until"] === "string" &&
        (reconciled["user"]["banned_until"] as string).length > 0;
      reconcileNote = banned
        ? "ban_applied_verified"
        : "ban_pending_retry_safe";
    } catch {
      reconcileNote = "ban_applied_unverified";
    }

    return NextResponse.json({
      ok: true,
      suspended: id,
      reconcile_note: reconcileNote,
    });
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}
