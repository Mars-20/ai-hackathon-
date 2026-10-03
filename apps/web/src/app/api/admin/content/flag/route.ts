// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/content/flag → { ok, startup_id, flagged } (spec §§3,6-7).
// Flag/unflag a startup (flag hides it from the queue's "unflagged" filter
// only; no effect on agent output). Executed through the single-transaction
// `admin_action` RPC (`flag_startup`) so the audit trail commits atomically;
// denies return { ok:false } with the trail preserved (no RAISE).
// ROLE_RANK max-own (viewer1 member2 admin3 owner4): platform tier bypasses;
// workspace tier needs member+ (rank >= 2) in the startup's workspace —
// viewers are already rejected at the requireAdmin gate and re-denied here
// and in the RPC. NULL-workspace legacy rows: platform only.
// Errors use the admin-only envelope { error, code } via toEnvelope().
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireAdminFromSupabase, toEnvelope } from "@/lib/admin";
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from "@/lib/supabase/server";

const ROLE_RANK: Record<string, number> = {
  viewer: 1,
  member: 2,
  admin: 3,
  owner: 4,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function rpcDenyToStatus(errorCode: string): number {
  switch (errorCode) {
    case "not_authenticated":
      return 401;
    case "forbidden":
      return 403;
    case "startup_not_found":
      return 404;
    case "invalid_startup_id":
    case "invalid_flag":
    case "unknown_action":
      return 400;
    default:
      return 400;
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
    if (!isRecord(body)) {
      return NextResponse.json(
        { error: "Missing flag fields", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }
    const startupId = body["startup_id"];
    const flagged = body["flagged"];
    const reason = body["reason"];
    if (typeof startupId !== "string" || startupId.length === 0) {
      return NextResponse.json(
        { error: "startup_id is required", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }
    if (typeof flagged !== "boolean") {
      return NextResponse.json(
        { error: "flagged must be a boolean", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }

    const service = createServiceRoleClient();
    const { data: startup, error: startupError } = await service
      .from("startups")
      .select("id,workspace_id")
      .eq("id", startupId)
      .maybeSingle();
    if (startupError) throw startupError;
    if (!isRecord(startup)) {
      return NextResponse.json(
        { error: "Startup not found", code: "NOT_FOUND" },
        { status: 404 },
      );
    }
    const startupWs = typeof startup["workspace_id"] === "string" ? (startup["workspace_id"] as string) : null;

    // Route-level ROLE_RANK max-own guard (the RPC re-enforces atomically):
    // workspace tier needs member+ in the startup's workspace. Scoping note:
    // this single-startup mutation resolves the startup's workspace first and
    // checks membership/rank on it — the single-id equivalent of the list-path
    // `.in('workspace_id', workspaceIds)` predicate (which lives in
    // scopedQuery); the RPC re-checks scope + rank inside the transaction.
    if (admin.tier !== "platform") {
      if (startupWs === null || !admin.workspaceIds.includes(startupWs)) {
        return NextResponse.json(
          { error: "Startup out of scope", code: "FORBIDDEN" },
          { status: 403 },
        );
      }
      const userClient = await createServerSupabaseClient();
      const { data: callerRow, error: callerError } = await userClient
        .from("workspace_members")
        .select("role")
        .eq("workspace_id", startupWs)
        .eq("user_id", admin.user.id)
        .maybeSingle();
      if (callerError) throw callerError;
      const callerRole =
        isRecord(callerRow) && typeof callerRow["role"] === "string"
          ? (callerRow["role"] as string)
          : null;
      if (callerRole === null || (ROLE_RANK[callerRole] ?? 0) < (ROLE_RANK["member"] ?? 2)) {
        return NextResponse.json(
          { error: "Flagging requires a member role or higher", code: "FORBIDDEN" },
          { status: 403 },
        );
      }
    }

    const userClient = await createServerSupabaseClient();
    const { data, error } = await userClient.rpc("admin_action", {
      action: "flag_startup",
      target: { startup_id: startupId },
      payload: { flagged: String(flagged) },
      reason: typeof reason === "string" ? reason : null,
    });
    if (error) throw error;
    if (isRecord(data) && data["ok"] === false) {
      const code = typeof data["error"] === "string" ? data["error"] : "unknown";
      return NextResponse.json(
        { error: code, code: code.toUpperCase() },
        { status: rpcDenyToStatus(code) },
      );
    }
    return NextResponse.json({ ok: true, startup_id: startupId, flagged });
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}
