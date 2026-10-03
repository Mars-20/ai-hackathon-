// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/users/[id] — workspace role change (privileged, audit-atomic
// via the `admin_action` RPC). DELETE /api/admin/users/[id] — revoke a
// workspace membership (privileged, audit-atomic via `admin_action`
// 'revoke_membership', spec §§6-7).
// ROLE_RANK anti-escalation (viewer 1 < member 2 < admin 3 < owner 4):
// the new role rank must be <= the caller's own rank, and only owner/admin
// callers may change roles (platform tier bypasses membership rank).
// Self-revoke of the last owner membership is blocked (409).
// Errors use the admin-only envelope { error, code } via toEnvelope().
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  requireAdminFromSupabase,
  toEnvelope,
} from "@/lib/admin";
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

const VALID_ROLES = ["owner", "admin", "member", "viewer"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function rpcDenyToStatus(errorCode: string): number {
  switch (errorCode) {
    case "not_authenticated":
      return 401;
    case "forbidden":
      return 403;
    case "invalid_role":
    case "workspace_id_and_user_id_required":
    case "invalid_workspace_id":
    case "invalid_user_id":
    case "unknown_action":
      return 400;
    case "membership_not_found":
      return 404;
    case "last_owner":
    case "last_platform_admin":
      return 409;
    default:
      return 400;
  }
}

export async function PATCH(
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
    const body: unknown = await request.json().catch(() => null);
    if (!isRecord(body)) {
      return NextResponse.json(
        { error: "Missing role change fields", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }
    const workspaceId = body["workspace_id"];
    const role = body["role"];
    const reason = body["reason"];
    if (typeof workspaceId !== "string" || workspaceId.length === 0) {
      return NextResponse.json(
        { error: "workspace_id is required", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }
    if (typeof role !== "string" || !VALID_ROLES.includes(role as (typeof VALID_ROLES)[number])) {
      return NextResponse.json(
        { error: "Invalid role", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }

    // Route-level ROLE_RANK max-own guard (the RPC re-enforces atomically).
    if (admin.tier !== "platform") {
      if (!admin.workspaceIds.includes(workspaceId)) {
        return NextResponse.json(
          { error: "Workspace out of scope", code: "FORBIDDEN" },
          { status: 403 },
        );
      }
      const scopeClient = await createServerSupabaseClient();
      const { data: callerRow, error: callerError } = await scopeClient
        .from("workspace_members")
        .select("role")
        .eq("workspace_id", workspaceId)
        .eq("user_id", admin.user.id)
        .maybeSingle();
      if (callerError) throw callerError;
      const callerRole =
        isRecord(callerRow) && typeof callerRow["role"] === "string"
          ? (callerRow["role"] as string)
          : null;
      if (callerRole !== "owner" && callerRole !== "admin") {
        return NextResponse.json(
          { error: "Insufficient permissions", code: "FORBIDDEN" },
          { status: 403 },
        );
      }
      const callerRank = ROLE_RANK[callerRole] ?? 0;
      const newRank = ROLE_RANK[role] ?? 0;
      if (newRank > callerRank) {
        return NextResponse.json(
          { error: "Cannot assign a role higher than your own", code: "FORBIDDEN" },
          { status: 403 },
        );
      }
    }

    // Privileged path: single-transaction `admin_action` RPC so audit
    // failure rolls back the mutation (two-client pattern forbidden here).
    const userClient = await createServerSupabaseClient();
    const { data, error } = await userClient.rpc("admin_action", {
      action: "role_change",
      target: { workspace_id: workspaceId, user_id: id },
      payload: { role, workspace_id: workspaceId },
      reason: typeof reason === "string" ? reason : null,
    });
    if (error) throw error;
    if (isRecord(data) && data["ok"] === false) {
      const code =
        typeof data["error"] === "string" ? data["error"] : "unknown";
      return NextResponse.json(
        { error: code, code: code.toUpperCase() },
        { status: rpcDenyToStatus(code) },
      );
    }
    return NextResponse.json({ ok: true, result: data ?? null });
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}

export async function DELETE(
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
    const url = new URL(request.url);
    const body: unknown = await request.json().catch(() => null);
    const workspaceId =
      (isRecord(body) && typeof body["workspace_id"] === "string"
        ? (body["workspace_id"] as string)
        : null) ?? url.searchParams.get("workspace_id");
    const reason =
      isRecord(body) && typeof body["reason"] === "string"
        ? (body["reason"] as string)
        : null;
    if (typeof workspaceId !== "string" || workspaceId.length === 0) {
      return NextResponse.json(
        { error: "workspace_id is required", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }
    if (admin.tier !== "platform" && !admin.workspaceIds.includes(workspaceId)) {
      return NextResponse.json(
        { error: "Workspace out of scope", code: "FORBIDDEN" },
        { status: 403 },
      );
    }

    const service = createServiceRoleClient();
    const userClient = await createServerSupabaseClient();

    const { data: targetRow, error: targetError } = await service
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspaceId)
      .eq("user_id", id)
      .maybeSingle();
    if (targetError) throw targetError;
    if (!isRecord(targetRow)) {
      return NextResponse.json(
        { error: "Membership not found", code: "NOT_FOUND" },
        { status: 404 },
      );
    }
    const targetRole =
      typeof targetRow["role"] === "string" ? targetRow["role"] : "member";

    if (admin.tier !== "platform") {
      const { data: callerRow, error: callerError } = await userClient
        .from("workspace_members")
        .select("role")
        .eq("workspace_id", workspaceId)
        .eq("user_id", admin.user.id)
        .maybeSingle();
      if (callerError) throw callerError;
      const callerRole =
        isRecord(callerRow) && typeof callerRow["role"] === "string"
          ? (callerRow["role"] as string)
          : null;
      if (callerRole !== "owner" && callerRole !== "admin") {
        return NextResponse.json(
          { error: "Insufficient permissions", code: "FORBIDDEN" },
          { status: 403 },
        );
      }
      if ((ROLE_RANK[targetRole] ?? 0) > (ROLE_RANK[callerRole ?? ""] ?? 0)) {
        return NextResponse.json(
          { error: "Cannot remove a member with a higher role", code: "FORBIDDEN" },
          { status: 403 },
        );
      }
    }

    // Self-revoke of the last owner membership is blocked (409).
    // Route-level fast guard; the RPC re-enforces atomically (last_owner).
    if (id === admin.user.id && targetRole === "owner") {
      const { count } = await service
        .from("workspace_members")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("role", "owner");
      if (typeof count === "number" && count <= 1) {
        return NextResponse.json(
          { error: "Cannot remove the last owner", code: "CONFLICT" },
          { status: 409 },
        );
      }
    }

    // Privileged path: single-transaction `admin_action` RPC
    // ('revoke_membership') so DELETE + audit commit atomically (spec §6;
    // two-client delete + warn-continue audit is forbidden here).
    const { data, error } = await userClient.rpc("admin_action", {
      action: "revoke_membership",
      target: { workspace_id: workspaceId, user_id: id },
      payload: { workspace_id: workspaceId, role: targetRole },
      reason,
    });
    if (error) throw error;
    if (isRecord(data) && data["ok"] === false) {
      const code =
        typeof data["error"] === "string" ? data["error"] : "unknown";
      return NextResponse.json(
        { error: code, code: code.toUpperCase() },
        { status: rpcDenyToStatus(code) },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}
