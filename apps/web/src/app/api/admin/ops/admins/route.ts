// ─────────────────────────────────────────────────────────────────────────────
// /api/admin/ops/admins (Task 5 addendum, Task 7 C1).
// GET → { admins, total }: platform_admins list (user_id + email +
// granted_by/granted_at). POST { user_id, reason? } → grant: platform-tier
// only via the `admin_action` RPC (`grant_platform`, audit-atomic).
// DELETE { user_id } (body or ?user_id=) → revoke: platform-tier only via
// the `admin_action` RPC (`revoke_platform`, audit-atomic; revoking the
// last platform admin is 409 CONFLICT).
// Matrix: platform tier full; workspace tier gets 403 on all three methods
// with a committed `denied` trail (Task-4 PATCH pattern — spec §6
// every-mutation-trail). The RPC is authoritative for the trail:
// non-platform callers still route through `admin_action` from the user
// client (which returns {ok:false,error:"forbidden"} and commits the
// denied row), then the route returns the stable 403 envelope below.
// Viewers get NONE at the requireAdmin gate. Errors use the admin-only
// envelope { error, code } via toEnvelope().
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireAdminFromSupabase, toEnvelope } from "@/lib/admin";
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from "@/lib/supabase/server";
import { createQueryDeps } from "@/lib/admin-queries/shared";
import { queryOpsAdmins } from "@/lib/admin-queries/ops";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function rpcDenyToStatus(errorCode: string): number {
  switch (errorCode) {
    case "not_authenticated":
      return 401;
    case "forbidden":
      return 403;
    case "membership_not_found":
      return 404;
    case "last_platform_admin":
      return 409;
    case "user_id_required":
    case "invalid_user_id":
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
    const dto = await queryOpsAdmins(deps);
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
    const userId =
      isRecord(body) && typeof body["user_id"] === "string"
        ? (body["user_id"] as string)
        : null;
    const reason =
      isRecord(body) && typeof body["reason"] === "string"
        ? (body["reason"] as string)
        : null;

    // Platform-tier only (Task-4 PATCH deny-trail pattern).
    if (admin.tier !== "platform") {
      try {
        const trailClient = await createServerSupabaseClient();
        await trailClient.rpc("admin_action", {
          action: "grant_platform",
          target: { user_id: userId },
          payload: {},
          reason,
        });
      } catch {
        // Best-effort trail: a trail failure must not mask the 403.
      }
      return NextResponse.json(
        { error: "Platform grants are platform-managed", code: "FORBIDDEN" },
        { status: 403 },
      );
    }

    if (!userId || userId.length === 0) {
      return NextResponse.json(
        { error: "user_id is required", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }

    const service = createServiceRoleClient();
    const { data: target } = await service.auth.admin.getUserById(userId);
    if (!isRecord(target) || !isRecord(target["user"])) {
      return NextResponse.json(
        { error: "User not found", code: "NOT_FOUND" },
        { status: 404 },
      );
    }

    // Privileged path: single-transaction `admin_action` RPC
    // (`grant_platform`) so the audit row and the grant commit
    // atomically (two-client pattern forbidden here).
    const userClient = await createServerSupabaseClient();
    const { data, error } = await userClient.rpc("admin_action", {
      action: "grant_platform",
      target: { user_id: userId },
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
    return NextResponse.json({ ok: true, granted: userId });
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}

export async function DELETE(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdminFromSupabase();
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }

  try {
    const body: unknown = await request.json().catch(() => null);
    const url = new URL(request.url);
    const fromBody =
      isRecord(body) && typeof body["user_id"] === "string"
        ? (body["user_id"] as string)
        : null;
    const fromQuery = url.searchParams.get("user_id");
    const userId =
      fromBody !== null && fromBody.length > 0
        ? fromBody
        : fromQuery !== null && fromQuery.trim().length > 0
          ? fromQuery.trim()
          : null;
    const reason =
      isRecord(body) && typeof body["reason"] === "string"
        ? (body["reason"] as string)
        : null;

    // Platform-tier only (Task-4 PATCH deny-trail pattern).
    if (admin.tier !== "platform") {
      try {
        const trailClient = await createServerSupabaseClient();
        await trailClient.rpc("admin_action", {
          action: "revoke_platform",
          target: { user_id: userId },
          payload: {},
          reason,
        });
      } catch {
        // Best-effort trail: a trail failure must not mask the 403.
      }
      return NextResponse.json(
        { error: "Platform grants are platform-managed", code: "FORBIDDEN" },
        { status: 403 },
      );
    }

    if (!userId || userId.length === 0) {
      return NextResponse.json(
        { error: "user_id is required", code: "BAD_REQUEST" },
        { status: 400 },
      );
    }

    // Privileged path: single-transaction `admin_action` RPC
    // (`revoke_platform`) so the audit row and the revoke commit
    // atomically (two-client pattern forbidden here).
    const userClient = await createServerSupabaseClient();
    const { data, error } = await userClient.rpc("admin_action", {
      action: "revoke_platform",
      target: { user_id: userId },
      payload: {},
      reason,
    });
    if (error) throw error;
    if (isRecord(data) && data["ok"] === false) {
      const code = typeof data["error"] === "string" ? data["error"] : "unknown";
      if (code === "membership_not_found") {
        return NextResponse.json(
          { error: "Platform admin not found", code: "NOT_FOUND" },
          { status: 404 },
        );
      }
      if (code === "last_platform_admin") {
        return NextResponse.json(
          {
            error: "Cannot revoke the last platform admin",
            code: "CONFLICT",
          },
          { status: 409 },
        );
      }
      return NextResponse.json(
        { error: code, code: code.toUpperCase() },
        { status: rpcDenyToStatus(code) },
      );
    }
    return NextResponse.json({ ok: true, revoked: userId });
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}
